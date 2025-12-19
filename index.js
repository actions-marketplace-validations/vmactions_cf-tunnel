"use strict";

const core = require('@actions/core');
const exec = require('@actions/exec');
const tc = require('@actions/tool-cache');
const io = require('@actions/io');
const fs = require("fs");
const path = require("path");
const os = require("os");


async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


async function download() {
  const CF_MAC_ARM = "https://github.com/cloudflare/cloudflared/releases/download/2025.11.1/cloudflared-darwin-arm64.tgz";
  const CF_MAC_AMD64 = "https://github.com/cloudflare/cloudflared/releases/download/2025.11.1/cloudflared-darwin-amd64.tgz";
  const CF_Linux = "https://github.com/cloudflare/cloudflared/releases/download/2025.11.1/cloudflared-linux-amd64";
  const CF_Linux_ARM = "https://github.com/cloudflare/cloudflared/releases/download/2025.11.1/cloudflared-linux-arm64";
  const CF_Win = "https://github.com/cloudflare/cloudflared/releases/download/2025.11.1/cloudflared-windows-amd64.exe";
  const CF_Win_ARM = "https://github.com/cloudflare/cloudflared/releases/download/2025.11.1/cloudflared-windows-arm64.exe";

  const isARM = os.arch() === "arm64" || os.arch() === "aarch64";
  let link = CF_Win;
  let ext = "";
  
  if (os.platform() === "darwin") {
    link = isARM ? CF_MAC_ARM : CF_MAC_AMD64;
    ext = "tgz";
  } else if (os.platform() === "linux") {
    link = isARM ? CF_Linux_ARM : CF_Linux;
  } else if (os.platform() === "win32") {
    link = isARM ? CF_Win_ARM : CF_Win;
  }


  let workingDir = __dirname;
  core.info("Downloading: " + link);
  const img = await tc.downloadTool(link);
  core.info("Downloaded file: " + img);

  // Basic validation of downloaded artifact
  try {
    const stat = fs.statSync(img);
    if (!stat.isFile() || stat.size === 0) {
      throw new Error("Downloaded file is missing or empty");
    }
  } catch (err) {
    core.setFailed("Download failed: " + err.message);
    throw err;
  }
  
  if (os.platform() === "darwin") {
    const tarFile = path.join(workingDir, "./cf." + ext);
    await io.mv(img, tarFile);
    await exec.exec("tar", ["-xzf", tarFile, "-C", workingDir]);
    try {
      await fs.promises.unlink(tarFile);
    } catch (err) {
      core.info("Could not remove tar file: " + err.message);
    }
  } else if (os.platform() === "linux") {
    await io.mv(img, path.join(workingDir, "./cloudflared"));
    await exec.exec("chmod", ["+x", path.join(workingDir, "./cloudflared")]);
  } else {
    await io.mv(img, path.join(workingDir, "./cloudflared.exe"));
  }
}

async function run(protocol, port) {
  let workingDir = __dirname;

  let cfd = path.join(workingDir, "./cloudflared");
  let log = path.join(workingDir, "./cf.log");
  
  if (os.platform() === "win32") {
    cfd += ".exe";
  }

  // Try to update cloudflared
  try {
    await exec.exec(cfd, ["update"]);
  } catch (e) {
    core.info("Update failed or not needed: " + e.message);
  }

  // Start tunnel in background
  if (os.platform() === "win32") {
    // Windows: use PowerShell to start background process
    const psCmd = `Start-Process -NoNewWindow -FilePath "${cfd}" -ArgumentList @('tunnel','--url','${protocol}://localhost:${port}','--output','json') -RedirectStandardOutput "${log}" -RedirectStandardError "${log}"`;
    await exec.exec("powershell", ["-Command", psCmd]);
  } else {
    // Unix: use shell to start background process
    await exec.exec("sh", [], { input: `${cfd} tunnel --url ${protocol}://localhost:${port} --output json >${log} 2>&1 &` });
  }


  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    
    // Read and parse log file (supports both JSON lines and plain text)
    let server = "";
    try {
      if (fs.existsSync(log)) {
        const logContent = fs.readFileSync(log, 'utf8');
        const lines = logContent.split('\n');
        
        for (const line of lines) {
          if (!line.trim()) continue;
          // Regex-first parse to handle non-JSON lines
          const regexMatch = line.match(/https?:\/\/([A-Za-z0-9.-]+\.trycloudflare\.com)/);
          if (regexMatch && regexMatch[1]) {
            server = regexMatch[1];
            break;
          }

          // Fallback to JSON parse if line is JSON
          try {
            const jsonLine = JSON.parse(line);
            if (jsonLine.message && typeof jsonLine.message === "string") {
              const msgMatch = jsonLine.message.match(/https?:\/\/([A-Za-z0-9.-]+\.trycloudflare\.com)/);
              if (msgMatch && msgMatch[1]) {
                server = msgMatch[1];
                break;
              }
            }
          } catch (e) {
            // Skip invalid JSON lines
          }
        }
      }
    } catch (e) {
      core.info("Error reading log: " + e.message);
    }
    
    if (!server) {
      continue;
    }
    core.info("server: " + server);
    
    // Write to GITHUB_OUTPUT
    if (os.platform() === "win32") {
      await exec.exec("powershell", ["-Command", `Add-Content -Path "$env:GITHUB_OUTPUT" -Value "server=${server}"`]);
    } else {
      await exec.exec("sh", [], { input: `echo "server=${server}" >> $GITHUB_OUTPUT` });
    }
    return;
  }
  
  // On timeout, surface a helpful log snippet for debugging
  if (fs.existsSync(log)) {
    try {
      const logContent = fs.readFileSync(log, 'utf8').trim().split('\n');
      const tailLines = logContent.slice(-20).join('\n');
      core.info("Last log lines:\n" + tailLines);
    } catch (e) {
      core.info("Could not read log tail: " + e.message);
    }
  }

  core.setFailed("Failed to get tunnel URL after 60 seconds. Please check the logs.");
}



async function main() {

  let protocol = core.getInput("protocol");
  core.info("protocol: " + protocol);
  if (!protocol) {
    protocol = "tcp";
  }

  let port = core.getInput("port");
  core.info("port: " + port);
  if (!port) {
    core.setFailed("No port !");
    return;
  }


  await download();

  await run(protocol, port);


  process.exit();
}



main().catch(ex => {
  core.setFailed(ex.message);
});

