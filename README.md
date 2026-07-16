# irbnet-export

A small Puppeteer utility for exporting projects and downloadable documents from IRBNet.

## Run with Docker

Build the image:

```sh
docker build -t irbnet-export .
```

Create the host output directory so exported metadata and documents persist after the container exits:

```sh
mkdir -p output
```

The easiest way to pass credentials is with an environment file:

```sh
docker run --rm \
  --env-file .env \
  --mount type=bind,source="$(pwd)/output",target=/app/output \
  irbnet-export
```

The `.env` file should contain:

```dotenv
IRBNET_USERNAME=your_user_here
IRBNET_PASSWORD=your_password_here
```

You can instead export the values in your shell and forward them individually without placing the values directly in command history:

```sh
export IRBNET_USERNAME="your_user_here"
export IRBNET_PASSWORD="your_password_here"

docker run --rm \
  --env IRBNET_USERNAME \
  --env IRBNET_PASSWORD \
  --mount type=bind,source="$(pwd)/output",target=/app/output \
  irbnet-export
```

On PowerShell, the equivalent bind mount uses `${PWD}`:

```powershell
docker run --rm `
  --env-file .env `
  --mount "type=bind,source=${PWD}/output,target=/app/output" `
  irbnet-export
```

Exports are written to `output/`, including `output/metadata.json`. Do not copy credentials into the image or commit `.env` or exported IRB/research data.

The container runs Chromium headlessly and uses `dumb-init` to clean up browser processes when it exits.

## Run directly with Node.js

Install dependencies, create `.env`, and run:

```sh
npm ci
node index.js
```

## Generative AI Disclosure
This project was built using generative AI tools. Use at your own risk.