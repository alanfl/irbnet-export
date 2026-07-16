import puppeteer from "puppeteer";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import readline from "readline";
import 'dotenv/config'


const OUTPUT_DIR = "output";
const METADATA_PATH = path.join(OUTPUT_DIR, "metadata.json");

let browser; // Global browser instance

async function main() {
    browser = await puppeteer.launch(getBrowserLaunchOptions());
    const page = await browser.newPage();
    await page.goto("https://www.irbnet.org/");
    console.log("Loaded IRBNet.");

    try {
        await login(page, process.env.IRBNET_USERNAME, process.env.IRBNET_PASSWORD);
    } catch (error) {
        console.error("Could not log in. Check credentials in .env file. Error:", error);
        await browser.close();
        return;
    }

    // console.log("Fetching projects...");
    // const all_projects = await getAllProjects(page);

    // DEBUG: dummy
    const all_projects = {
        "projects": [
            {
                "projectId": "2231737",
                "projectLink": "https://www.irbnet.org/release/study/overview.do?ctx_id=0&spk_id=2231737",
                "projectTitle": "Collaborative Research: SaTC: CORE: Medium: Beyond App-centric Privacy: Investigating Privacy Ecosystems among Vulnerable Populations",
                "status": "Approved",
                "packages": []
            }
        ]
    }

    // For each project, create a corresponding directory in output
    for (const project of all_projects.projects) {
        await mkdir(path.join(OUTPUT_DIR, project.projectId), { recursive: true });
    }

    console.log(`Processing projects...`);
    for (const project of all_projects.projects) {
        console.log(`Processing project: ${project.projectTitle} (ID: ${project.projectId})`);
        const packages = await getAllPackages(project);


        project.packages = packages;
    }

    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(METADATA_PATH, JSON.stringify(all_projects, null, 2) + "\n");
}

main();

function getBrowserLaunchOptions() {
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    const headless = process.env.PUPPETEER_HEADLESS === "true";
    const launchOptions = {
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        headless: headless
    };

    if (executablePath) {
        launchOptions.executablePath = executablePath;
    }

    return launchOptions;
}

async function login(page, user, pass) {
    if (!user || !pass) {
        throw new Error("Missing IRBNET_USERNAME or IRBNET_PASSWORD in .env file.");
    }

    await page.type("#j_username", user);
    await page.type("#j_password", pass);
    await page.click('input[name="login"]');
    await page.waitForSelector(".rd-prj-title-text");
    console.log("Logged in to IRBNet successfully!");
}

async function getAllPackages(project) {
    const projectPage = await browser.newPage();

    try {
        await projectPage.goto(project.projectLink, { waitUntil: "domcontentloaded" });

        // IRBNet project Overview screen: follow the visible Designer link to its document table.
        await projectPage.waitForSelector("a[href*=\"designer.do\"]", { visible: true });
        await Promise.all([
            projectPage.waitForNavigation({ waitUntil: "networkidle2" }),
            projectPage.click("a[href*=\"designer.do\"]")
        ]);
        await projectPage.waitForSelector("tbody.yui-dt-data");

        const all_documents = await projectPage.$$eval("tbody.yui-dt-data > tr", rows => rows.map(row => {
            const getText = selector => row.querySelector(selector)?.textContent.trim() || null;
            const descriptionElement = row.querySelector(".yui-dt-col-documentDescription span");

            return {
                packageNumber: getText(".pkg-nbr-col .yui-dt-liner"),
                documentType: getText(".yui-dt-col-documentType .document-type"),
                description: descriptionElement?.getAttribute("title")?.trim()
                    || descriptionElement?.textContent.trim()
                    || null,
                lastModifiedDate: getText(".yui-dt-col-lastModified span"),
                submissionDate: getText(".yui-dt-col-pkgSubmissionDate .yui-dt-liner"),
                downloadLink: row.querySelector("a[href*=\"/release/document/download.do\"]")?.href || null
            };
        }).filter(document => document.packageNumber));

        const packages = [];
        const packagesByNumber = new Map();

        for (const document of all_documents) {
            let packageRecord = packagesByNumber.get(document.packageNumber);

            if (!packageRecord) {
                packageRecord = {
                    packageNumber: document.packageNumber,
                    documents: []
                };
                packagesByNumber.set(document.packageNumber, packageRecord);
                packages.push(packageRecord);
            }

            const { packageNumber, ...documentRecord } = document;
            packageRecord.documents.push(documentRecord);
        }

        console.log(`Found ${all_documents.length} documents across ${packages.length} packages.`);
        const projectOutputDirectory = path.resolve(OUTPUT_DIR, project.projectId);
        const downloadSession = await projectPage.target().createCDPSession();

        try {
            for (const packageRecord of packages) {
                const packageDirectoryName = packageRecord.packageNumber.replace(/[^a-zA-Z0-9._-]/g, "_");
                const packageDirectory = path.join(projectOutputDirectory, packageDirectoryName);
                await mkdir(packageDirectory, { recursive: true });

                for (const document of packageRecord.documents) {
                    if (!document.downloadLink) {
                        continue;
                    }

                    await downloadSession.send("Browser.setDownloadBehavior", {
                        behavior: "allow",
                        downloadPath: packageDirectory,
                        eventsEnabled: true
                    });

                    const [download] = await Promise.all([
                        waitForDownload(downloadSession),
                        clickDownloadLink(projectPage, document.downloadLink)
                    ]);
                    const downloadedFilePath = download.filePath
                        || path.join(packageDirectory, download.suggestedFilename);

                    document.fileName = download.suggestedFilename;
                    document.downloadPath = path.relative(process.cwd(), downloadedFilePath);
                }
            }
        } finally {
            await downloadSession.detach();
        }
        return packages;
    } finally {
        await projectPage.close();
    }
}

async function clickDownloadLink(page, downloadLink) {
    await page.evaluate(linkHref => {
        const link = Array.from(document.querySelectorAll("a"))
            .find(candidate => candidate.href === linkHref);

        if (!link) {
            throw new Error("Could not find the document download link.");
        }

        link.click();
    }, downloadLink);
}

function waitForDownload(session, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        let downloadGuid = null;
        let suggestedFilename = null;

        const cleanup = () => {
            clearTimeout(timeoutId);
            session.off("Browser.downloadWillBegin", onDownloadWillBegin);
            session.off("Browser.downloadProgress", onDownloadProgress);
        };

        const onDownloadWillBegin = event => {
            if (downloadGuid) {
                return;
            }

            downloadGuid = event.guid;
            suggestedFilename = event.suggestedFilename;
        };

        const onDownloadProgress = event => {
            if (!downloadGuid || event.guid !== downloadGuid) {
                return;
            }

            if (event.state === "completed") {
                cleanup();
                resolve({
                    filePath: event.filePath,
                    suggestedFilename
                });
            } else if (event.state === "canceled") {
                cleanup();
                reject(new Error("The document download was canceled."));
            }
        };

        const timeoutId = setTimeout(() => {
            cleanup();
            reject(new Error(`Document download did not finish within ${timeoutMs}ms.`));
        }, timeoutMs);

        session.on("Browser.downloadWillBegin", onDownloadWillBegin);
        session.on("Browser.downloadProgress", onDownloadProgress);
    });
}

async function getAllProjects(page) {
    const all_projects = { projects: [] };
    const seenProjectIds = new Set();
    let morePages = true;
    while(morePages) {
        let projectsOnPage = await fetchProjectsOnPage(page);
        for (const project of projectsOnPage) {
            if (!project.projectId || seenProjectIds.has(project.projectId)) {
                continue;
            }

            seenProjectIds.add(project.projectId);
            all_projects.projects.push({ ...project, packages: [] });
        }

        // DEBUGGING: log status of next-page controls
        // let nextPageControls = await page.$$eval("#yui-pg0-1-next-link", elements => elements.map((element, index) => ({
        //     index,
        //     tagName: element.tagName,
        //     text: element.textContent.trim(),
        //     href: element.getAttribute("href"),
        //     className: element.className,
        //     ariaDisabled: element.getAttribute("aria-disabled"),
        //     visible: Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length)
        // })));
        // console.log("Next-page controls:", nextPageControls);

        // Check if element with id "yui-pg0-1-next-link" is an anchor and not a span (indicating there are more pages)
        let nextPageElement = await page.$("#yui-pg0-1-next-link");
        if (nextPageElement) {
            let tagName = await page.evaluate(el => el.tagName, nextPageElement);
            // console.log(`Selected first next-page control with tag: ${tagName}`);
            if (tagName === "A") {
                const currentProjectLinks = projectsOnPage.map(project => project.projectLink).filter(Boolean);
                await Promise.all([
                    page.waitForFunction(previousProjectLinks => {
                        const nextProjectLinks = Array.from(
                            document.querySelectorAll("tbody.yui-dt-data > tr div.rd-prj-title-text a"),
                            link => link.href
                        );

                        return nextProjectLinks.length > 0
                            && nextProjectLinks.join("|") !== previousProjectLinks.join("|");
                    }, { timeout: 30000 }, currentProjectLinks),
                    nextPageElement.click()
                ]);
            } else {
                // console.log(`No more pages to fetch. Next-page control is a ${tagName}.`);
                morePages = false;
            }
        } else {
            // console.log("No more pages to fetch. Next-page control was not found.");
            morePages = false;
        }
    }
    console.log(`Fetched a total of ${all_projects.projects.length} unique projects.`);
    return all_projects;
}


async function fetchProjectsOnPage(page) {
    const projects = await page.$$eval("tbody.yui-dt-data > tr", rows => rows.map(tr => {
        const titleDiv = tr.querySelector("div.rd-prj-title-text");
        const projectLink = titleDiv && titleDiv.querySelector("a") ? titleDiv.querySelector("a").href : null;
        const projectId = titleDiv && titleDiv.querySelector("a") ? titleDiv.querySelector("a").href.split("spk_id=")[1] : null;
        const projectTitle = titleDiv ? titleDiv.querySelector("a").title : null;

        const statusTd = tr.querySelector("td.irbnet-board-action-type");
        const statusSpan = statusTd ? statusTd.querySelector("span.help") : null;
        const status = statusSpan ? statusSpan.innerText.trim() : null;

        return {
            projectId,
            projectLink,
            projectTitle,
            status
        };
    }));
    console.log(`Found ${projects.length} projects on this page.`);
    return projects;
}
