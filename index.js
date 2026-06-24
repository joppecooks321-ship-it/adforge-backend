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
);

function srtTime(seconds) {
  const date = new Date(seconds * 1000).toISOString().slice(11, 23);
  return date.replace(".", ",");
}

function segmentsToSrt(segments) {
  return segments
    .map((segment, index) => {
      return `${index + 1}
${srtTime(segment.start)} --> ${srtTime(segment.end)}
${segment.text.trim()}
`;
    })
    .join("\n");
}

async function downloadFile(url, outputPath) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download video: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
}

async function runFfmpeg(args) {
  await execFileAsync("ffmpeg", args);
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

  const { jobId, signedRawUrl, editedUploadPath } = req.body;

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
    await supabase
      .from("video_jobs")
      .update({ status: "processing" })
      .eq("id", jobId);

    const workDir = `/tmp/${jobId}`;
    fs.mkdirSync(workDir, { recursive: true });

    const inputVideo = path.join(workDir, "input.mp4");
    const audioFile = path.join(workDir, "audio.mp3");
    const captionsFile = path.join(workDir, "captions.srt");
    const outputVideo = path.join(workDir, "output.mp4");

    await downloadFile(signedRawUrl, inputVideo);

    await runFfmpeg([
      "-y",
      "-i",
      inputVideo,
      "-vn",
      "-acodec",
      "mp3",
      audioFile
    ]);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFile),
      model: "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"]
    });

    const segments = transcription.segments || [];

    if (segments.length === 0) {
      throw new Error("No transcript segments found");
    }

    const srt = segmentsToSrt(segments);
    fs.writeFileSync(captionsFile, srt);

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

    const videoBuffer = fs.readFileSync(outputVideo);

    const uploadResult = await supabase.storage
      .from("edited-videos")
      .upload(editedUploadPath, videoBuffer, {
        contentType: "video/mp4",
        upsert: true
      });

    if (uploadResult.error) {
      throw uploadResult.error;
    }

    await supabase
      .from("video_jobs")
      .update({
        status: "done",
        edited_path: editedUploadPath
      })
      .eq("id", jobId);
  } catch (error) {
    console.error(error);

    await supabase
      .from("video_jobs")
      .update({
        status: "failed",
        error_message: error.message
      })
      .eq("id", jobId);
  }
});

app.listen(PORT, () => {
  console.log(`Adforge backend running on port ${PORT}`);
});
