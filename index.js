import puppeteer from "puppeteer";
import readline from "readline";
import 'dotenv/config'


let browser; // Global browser instance

async function main() {
    // Check if process.argv includes --approved-only flag
    const params = {};
    params.approvedOnly = process.argv.includes("--approved-only");

    // If --approved-only flag is not present, prompt user for input
    if (!params.approvedOnly) {
        params.approvedOnly = await getUserParam("Extract only projects marked as 'Approved'? (y/n): ", {
            "y": true,
            "n": false
        });
    }

    browser = await puppeteer.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        headless: "false",
    });

    let projects = await fetchProjects();

    // for (project of projects) {
    //     if(project.status !== "Approved" && params.approvedOnly) {
    //         console.log(`Skipping project ${project.projectTitle} with status ${project.status}`);
    //         continue;
    //     }

    //     console.log('Downloading project: ' + project.projectTitle);
    //     await downloadProject(project, params);
    // }
}

main();

function getUserParam(query, responseMap) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => rl.question(query, (answer) => {
        const response = responseMap[answer.toLowerCase()];
        if (response !== undefined) {
            resolve(response);
        } else {
            console.log("Invalid input. Input must be one of: " + Object.keys(responseMap).join(", "));
            rl.prompt();
        }
    }));
}

async function fetchProjects() {
    const page = await browser.newPage();

    await page.goto("https://www.irbnet.org/");
    console.log("Loaded IRBNet.");

    // Login
    try {
        await page.type("#j_username", process.env.IRBNET_USERNAME);
        await page.type("#j_password", process.env.IRBNET_PASSWORD);
        await page.click('input[name="login"]');
    } catch (error) {
        console.error("Could not log in. Check credentials in .env file. Error:", error);
        await browser.close();
        return [];
    }

    await page.waitForSelector(".rd-prj-title-text");
    console.log("Logged in to IRBNet successfully!");

    console.log("Mapping projects...");
    
    // Mapping project objects
    let projects = await page.$$eval("tbody.yui-dt-data > tr", rows => rows.map(tr => {
        const titleDiv = tr.querySelector("div.rd-prj-title-text");
        const projectId = titleDiv && titleDiv.querySelector("a") ? titleDiv.querySelector("a").href.split("spk_id=")[1] : null;
        const projectTitle = titleDiv ? titleDiv.querySelector("a").title : null;

        const statusTd = tr.querySelector("td.irbnet-board-action-type");
        const statusSpan = statusTd ? statusTd.querySelector("span.help") : null;
        const status = statusSpan ? statusSpan.innerText.trim() : null;

        return {
            projectId,
            projectTitle,
            status
        };
    }));

    console.log(`Found ${projects.length} projects.`);
    console.log(projects);
    return projects;
}

async function downloadProject(project, params) {
    const projectPage = await browser.newPage();
    await projectPage.goto('https://www.irbnet.org/release/study/designer.do?spk_id=' + project.projectId);

    // Select div with id "show-all-documents" anchor child and parse the onClick attribute's substring of doShowAllDocuments(LINK) and extract the LINK value
    

    // console.log(`Opened project: ${project.projectTitle}`);

    // Get current package version
}