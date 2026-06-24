import ws from "ws";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const execFileAsync = promisify(execFile);

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    realtime: {
      transport: ws
    }
  }
);

function srtTime(seconds) {
  const date = new Date(seconds * 1000).toISOString().slice(11, 23);
  return date.replace(".", ",");
}

function segmentsToSrt(segments) {
  return segments
    .map((segment, index) => `${index + 1}
${srtTime(segment.start)} --> ${srtTime(segment.end)}
${segment.text.trim()}
`)
    .join("\n");
}

async function downloadFile(url, outputPath) {
  console.log("Download URL starts with:", String(url).slice(0, 80));

  const parsedUrl = new URL(url);

  const response = await fetch(parsedUrl);

  if (!response.ok) {
    throw new Error(`Failed to download video: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
}

async function runFfmpeg(args) {
  console.log("Running ffmpeg:", args.join(" "));

  try {
    const { stdout, stderr } = await execFileAsync("ffmpeg", args, {
      maxBuffer: 1024 * 1024 * 20
    });

    if (stdout) console.log("ffmpeg stdout:", stdout);
    if (stderr) console.log("ffmpeg stderr:", stderr);
  } catch (error) {
    console.error("FFmpeg failed:", error?.stderr || error?.message || error);
    throw error;
  }
}

async function updateJobSafe(jobId, data) {
  console.log("Updating job:", jobId, data);

  const { error } = await supabase
    .from("video_jobs")
    .update(data)
    .eq("id", jobId);

  if (error) {
    console.error("Supabase update error:", error);
    throw error;
  }
}

async function transcribeAudio(audioFile) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`Transcription attempt ${attempt}`);

      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(audioFile),
        model: "gpt-4o-mini-transcribe",
        response_format: "json"
      });

      const text = transcription.text || "";

      if (!text.trim()) {
        throw new Error("No transcription text found");
      }

      console.log("Transcription success. Text length:", text.length);
      return text;
    } catch (error) {
      lastError = error;
      console.error(`Transcription attempt ${attempt} failed:`, error?.message || error);

      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  throw lastError;
}

function makeShortCaption(text) {
  const clean = String(text).replace(/\s+/g, " ").trim();

  if (clean.length <= 180) return clean;

  return clean.slice(0, 180).trim() + "...";
}

app.get("/", (req, res) => {
  res.send("Adforge backend is running");
});

app.post("/process-video", async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const expectedSecret = process.env.PROCESS_VIDEO_SECRET;

  if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { jobId, signedRawUrl, editedUploadPath } = req.body || {};

  console.log("========== REQUEST ==========");
  console.log("jobId:", jobId);
  console.log("signedRawUrl:", signedRawUrl);
  console.log("editedUploadPath:", editedUploadPath);
  console.log("=============================");

  if (!jobId || !signedRawUrl || !editedUploadPath) {
    return res.status(400).json({
      error: "Missing jobId, signedRawUrl or editedUploadPath"
    });
  }

  res.json({
    status: "processing",
    jobId
  });

  try {
    console.log("Starting job:", jobId);

    await updateJobSafe(jobId, {
      status: "processing",
      error_message: null
    });

    const workDir = `/tmp/${jobId}`;
    fs.mkdirSync(workDir, { recursive: true });

    const inputVideo = path.join(workDir, "input.mp4");
    const audioFile = path.join(workDir, "audio.mp3");
    const captionsFile = path.join(workDir, "captions.srt");
    const outputVideo = path.join(workDir, "output.mp4");

    console.log("Downloading video");
    await downloadFile(signedRawUrl, inputVideo);

    console.log("Extracting audio");
    await runFfmpeg([
      "-y",
      "-i",
      inputVideo,
      "-vn",
      "-acodec",
      "mp3",
      audioFile
    ]);

    console.log("Transcribing audio");
    const text = await transcribeAudio(audioFile);

    console.log("Creating captions");
    const captionText = makeShortCaption(text);

    const segments = [
      {
        start: 0,
        end: 10,
        text: captionText
      }
    ];

    fs.writeFileSync(captionsFile, segmentsToSrt(segments));

    console.log("Burning captions");
    await runFfmpeg([
      "-y",
      "-i",
      inputVideo,
      "-vf",
      `subtitles=${captionsFile}:force_style='Fontsize=24,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=40'`,
      "-c:a",
      "copy",
      outputVideo
    ]);

    console.log("Uploading edited video to path:", editedUploadPath);
    const videoBuffer = fs.readFileSync(outputVideo);

    const uploadResult = await supabase.storage
      .from("edited-videos")
      .upload(editedUploadPath, videoBuffer, {
        contentType: "video/mp4",
        upsert: true
      });

    if (uploadResult.error) {
      console.error("Upload error:", uploadResult.error);
      throw uploadResult.error;
    }

    await updateJobSafe(jobId, {
      status: "done",
      edited_path: editedUploadPath,
      error_message: null
    });

    console.log("Job done:", jobId);
  } catch (error) {
    const message = error?.message || String(error);

    console.error("Processing failed:", message);

    try {
      await updateJobSafe(jobId, {
        status: "failed",
        error_message: message
      });

      console.log("Marked job as failed in Supabase");
    } catch (supabaseError) {
      console.error("Could not update job as failed:", supabaseError?.message || supabaseError);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Adforge backend running on port ${PORT}`);
});
