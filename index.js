import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;

const PROCESS_VIDEO_SECRET = process.env.PROCESS_VIDEO_SECRET;
const PROCESS_VIDEO_URL = process.env.PROCESS_VIDEO_URL;

async function sendCallback({ jobId, status, editedPath, errorMessage }) {
  const response = await fetch(PROCESS_VIDEO_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PROCESS_VIDEO_SECRET}`,
    },
    body: JSON.stringify({
      jobId,
      status,
      editedPath: editedPath || null,
      errorMessage: errorMessage || null,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Callback failed: ${response.status} ${text}`);
  }

  console.log("Callback sent");
}

async function downloadFile(url, outputPath) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download video: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
}

async function uploadToSignedUrl(filePath, signedUploadUrl) {
  const videoBuffer = fs.readFileSync(filePath);

  const response = await fetch(signedUploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
    },
    body: videoBuffer,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to upload video: ${response.status} ${text}`);
  }

  console.log("Upload complete");
}

async function runFfmpeg(args) {
  console.log("Running ffmpeg:", args.join(" "));

  try {
    const { stdout, stderr } = await execFileAsync("ffmpeg", args, {
      maxBuffer: 1024 * 1024 * 50,
    });

    if (stdout) console.log(stdout);
    if (stderr) console.log(stderr);
  } catch (error) {
    console.error("FFmpeg failed:");
    console.error(error?.stderr || error);
    throw error;
  }
}

app.get("/", (req, res) => {
  res.send("Adforge backend is running");
});

app.post("/process-video", async (req, res) => {
  const authHeader = req.headers.authorization || "";

  if (!PROCESS_VIDEO_SECRET || authHeader !== `Bearer ${PROCESS_VIDEO_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { jobId, signedRawUrl, editedUploadPath } = req.body || {};

  if (!jobId || !signedRawUrl || !editedUploadPath) {
    return res.status(400).json({
      error: "Missing jobId, signedRawUrl or editedUploadPath",
    });
  }

  res.json({
    status: "processing",
    jobId,
  });

  const workDir = `/tmp/${jobId}`;

  try {
    fs.mkdirSync(workDir, { recursive: true });

    const inputVideo = path.join(workDir, "input.mp4");
    const outputVideo = path.join(workDir, "output.mp4");

    console.log("Downloading video");
    await downloadFile(signedRawUrl, inputVideo);

    console.log("Adding fixed caption");

    await runFfmpeg([
      "-y",
      "-i",
      inputVideo,
      "-vf",
      "format=yuv420p,drawtext=text='Your product. Your story. Ready to scale.':fontcolor=white:fontsize=42:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h-140",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      outputVideo,
    ]);

    console.log("Uploading edited video");
    await uploadToSignedUrl(outputVideo, editedUploadPath);

    console.log("Sending done callback");
    await sendCallback({
      jobId,
      status: "done",
      editedPath: editedUploadPath,
      errorMessage: null,
    });

    console.log("Job done:", jobId);
  } catch (error) {
    const message = error?.message || String(error);

    console.error("Processing failed:");
    console.error(error);

    try {
      await sendCallback({
        jobId,
        status: "failed",
        editedPath: null,
        errorMessage: message,
      });
    } catch (callbackError) {
      console.error("Callback failed:");
      console.error(callbackError);
    }
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`Adforge backend running on port ${PORT}`);
});
