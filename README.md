# Live Subtitles Anywhere

Subtitles for any video in Chrome (YouTube, Facebook, course sites, news sites, embedded players…). Two ways:

- **Live (AI)**: listens to the video in any spoken language and writes subtitles as it plays, with optional translation.
- **Subtitle file**: load your own .srt / .vtt / .ass / .ssa file. It stays in sync when you pause, jump, rewind or change speed.

## Install (Chrome, Edge, Brave)
1. Unzip this folder.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `live-subtitles` folder.
4. Pin the extension from the puzzle-piece icon.

## Subtitle file mode (no API key needed)
1. Open the video page, click the extension, choose the **📄 Subtitle file** tab, then **Open subtitle file panel on this tab**.
2. In the panel on the page, click **Choose subtitle file…** or drag the file onto the page.
3. Play the video. You can jump anywhere and the right line shows.
4. If the timing is off:
   - **Delay buttons** (−1s, −0.1, +0.1, +1s), or the keyboard: **G** = subtitles earlier, **H** = later, hold **Shift** for 1-second steps.
   - **Quick sync**: use ◀ ▶ to pick a line, then press **🎯 This line is being said now** the moment you hear it. The delay is fixed for you.
   - The delay is remembered for that file name.
5. Broken letters (common with old Arabic .srt files)? The encoding is detected automatically, but you can pick it under **Text encoding**.
6. **Show subtitles in** translates the file into another language as it plays.
7. Click **×** on the panel to remove the subtitles.

## Subtitle style
Click the extension and open **🎨 Subtitle style**. Every change shows in the preview and on the video right away, in both modes:
- Size, height from the bottom of the video, max line width
- Text color (plus quick color dots), background color and opacity (0% = no box), color of the original line
- Font, text edge (none / shadow / outline / both), bold
- Presets: Classic, Yellow, No box, Large, and Reset

## Live mode: get a free API key
The speech recognition uses Whisper. Groq offers it with a free tier:
1. Sign up at https://console.groq.com/keys and create a key.
2. Paste it in the extension popup. (An OpenAI key works too — pick "OpenAI Whisper".)

## Live mode: use
1. Open a page with a video.
2. Click the extension → choose "Show subtitles in" (e.g. العربية) → **Start subtitles on this tab**.
3. Play the video. Subtitles appear at the bottom after ~5–7 seconds.
4. Click the extension again → **Stop subtitles** when done.

## Notes
- Subtitles lag the speech by a few seconds, because audio is sent in 5-second pieces.
- Words split across two pieces may occasionally be misheard.
- Translation uses Google Translate's free public endpoint.
- In fullscreen, subtitles show inside most players (YouTube, etc.). On sites that fullscreen the bare video element, they only show in normal/theater mode.
- Your API key is stored only in your browser. Audio is sent to the provider you choose for transcription.
