#!/bin/zsh
# Assembles the HomeLedger demo video from the recorded takes, the voice-over
# cues and the title/caption cards. Each segment is rendered to its own mp4
# (1920x1080, 25 fps, AAC), then all are concatenated. Phone footage (CAM) is
# optional: drop clips in ~/Desktop/HomeLedger-Takes/cam/ as door.mov and sensor.mov.
set -e
T=~/Desktop/HomeLedger-Takes; VO=~/Desktop/HomeLedger-VO
C=/Users/joseph.karns/Documents/Repositories/homeledger/docs/assets/video
A=/Users/joseph.karns/Documents/Repositories/homeledger/docs/assets/architecture.png
OUT=~/Desktop/HomeLedger-Cut; S=$OUT/segments; mkdir -p $S; cd $OUT
KEEP=$T/ask+book+hood-2026-10-21-20-04.mp4; ARR=$T/arrive-2026-10-22-19-13.mp4; ALT=$T/alert-2026-10-21-20-53.mp4
CAMDOOR=$T/cam/door.mp4; CAMSENSOR=$T/cam/sensor.mp4
DOOR_IN=${DOOR_IN:-0}; SENSOR_IN=${SENSOR_IN:-0}
FIT="scale=-2:1080:flags=lanczos,pad=1920:1080:(ow-iw)/2:0:black,setsar=1,fps=25,format=yuv420p"
CAMFIT="split[bg][fg];[bg]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=30:5,eq=brightness=-0.15[bgb];[fg]scale=-2:1080:flags=lanczos[fgs];[bgb][fgs]overlay=(W-w)/2:0,setsar=1,fps=25,format=yuv420p"
ENC=(-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -r 25 -c:a aac -b:a 160k -ar 48000 -ac 2)

# seg NAME LEN "VIDEO-FILTERGRAPH producing [v]" INPUTS... ; audio = VO mixed in by seg_audio
# Helper: render a segment from a filter graph string that ends with [v] and [a].
render() { local name=$1; shift; local len=$1; shift; local graph=$1; shift
  ffmpeg -hide_banner -loglevel error -y "$@" -filter_complex "$graph" -map "[v]" -map "[a]" -t $len "${ENC[@]}" $S/$name.mp4
  printf "%-10s %5.1fs\n" $name $(ffprobe -v error -show_entries format=duration -of csv=p=0 $S/$name.mp4); }
# Audio graph: VO cue at offset, padded to the segment length. $1 = input index of the VO, $2 = delay ms
voa() { echo "[${1}:a]adelay=${2}|${2},apad,aformat=sample_rates=48000:channel_layouts=stereo[a]"; }

# 1. Hook (10 s): CAM press if present (4 s), then the card landing. VO 01 at 1.5 s.
if [ -f $CAMDOOR ]; then
  render 01-hook 10 "[0:v]trim=${DOOR_IN}:$((DOOR_IN+4)),setpts=PTS-STARTPTS,${CAMFIT}[c];[1:v]trim=60:66,setpts=PTS-STARTPTS,${FIT}[s];[c][s]concat=n=2:v=1:a=0[v];$(voa 2 1500)" -i $CAMDOOR -i $ARR -i $VO/01-hook.mp3
else
  render 01-hook 10 "[0:v]trim=57:67,setpts=PTS-STARTPTS,${FIT}[v];$(voa 1 2500)" -i $ARR -i $VO/01-hook.mp3
fi
# 2. Title (15 s), VO 02 at 0.5 s.
render 02-title 15 "[0:v]${FIT}[v];$(voa 1 500)" -loop 1 -t 15 -i $C/title.png -i $VO/02-title.mp3
# 3. Ask (31 s): keeper 4–50 s at 1.5x. VO 03a at 1 s, 03b at 19 s.
render 03-ask 31 "[0:v]trim=4:50,setpts=(PTS-STARTPTS)/1.5,${FIT}[v];[1:a]adelay=1000|1000[a1];[2:a]adelay=19500|19500[a2];[a1][a2]amix=inputs=2:normalize=0,apad,aformat=sample_rates=48000:channel_layouts=stereo[a]" -i $KEEP -i $VO/03a-ask.mp3 -i $VO/03b-log.mp3
# 4. Book (32 s): keeper 52–84 s. VO 04 at 9 s.
render 04-book 32 "[0:v]trim=52:84,setpts=PTS-STARTPTS,${FIT}[v];$(voa 1 9000)" -i $KEEP -i $VO/04-book.mp3
# 5. Arrive (26 s): captions day (0–4), disclosure (4–12), timing (17–24). CAM press (3 s) if present, then arrival 58–81.
if [ -f $CAMDOOR ]; then
  render 05-arrive 26 "[0:v]trim=${DOOR_IN}:$((DOOR_IN+3)),setpts=PTS-STARTPTS,${CAMFIT}[c];[1:v]trim=58:81,setpts=PTS-STARTPTS,${FIT}[s];[c][s]concat=n=2:v=1:a=0[b];[b][3:v]overlay=enable='between(t,0,4)'[b1];[b1][4:v]overlay=enable='between(t,4,12)'[b2];[b2][5:v]overlay=enable='between(t,17,24)'[v];$(voa 2 3000)" -i $CAMDOOR -i $ARR -i $VO/05-arrive.mp3 -i $C/caption-friday.png -i $C/caption-disclosure.png -i $C/caption-timing.png
else
  render 05-arrive 26 "[0:v]trim=56:82,setpts=PTS-STARTPTS,${FIT}[b];[b][2:v]overlay=enable='between(t,0,4)'[b1];[b1][3:v]overlay=enable='between(t,4,12)'[b2];[b2][4:v]overlay=enable='between(t,17,24)'[v];$(voa 1 3000)" -i $ARR -i $VO/05-arrive.mp3 -i $C/caption-friday.png -i $C/caption-disclosure.png -i $C/caption-timing.png
fi
# 6. Alert (25 s): CAM sensor (3 s) if present; alert 60–72 (notice + still active) then 145–158 (check again + cleared). VO 06 at 2 s. Caption 0–5 s.
if [ -f $CAMSENSOR ]; then
  render 06-alert 25 "[0:v]trim=${SENSOR_IN}:$((SENSOR_IN+3)),setpts=PTS-STARTPTS,${CAMFIT}[c];[1:v]trim=60:71,setpts=PTS-STARTPTS,${FIT}[s1];[1:v]trim=146:157,setpts=PTS-STARTPTS,${FIT}[s2];[c][s1][s2]concat=n=3:v=1:a=0[b];[b][3:v]overlay=enable='between(t,0,5)'[v];$(voa 2 2000)" -i $CAMSENSOR -i $ALT -i $VO/06-alert.mp3 -i $C/caption-alert.png
else
  render 06-alert 25 "[0:v]trim=60:72,setpts=PTS-STARTPTS,${FIT}[s1];[0:v]trim=145:158,setpts=PTS-STARTPTS,${FIT}[s2];[s1][s2]concat=n=2:v=1:a=0[b];[b][2:v]overlay=enable='between(t,0,5)'[v];$(voa 1 2000)" -i $ALT -i $VO/06-alert.mp3 -i $C/caption-alert.png
fi
# 7. Under the hood (20 s): drawer 88–100 with the account id masked, then the architecture slide 8 s. VO 07 at 1 s.
render 07-hood 20 "[0:v]trim=88:100,setpts=PTS-STARTPTS,$FIT,drawbox=x=205:y=330:w=1210:h=66:color=black:t=fill:enable='gte(t,2.2)'[d];[1:v]${FIT}[p];[d][p]concat=n=2:v=1:a=0[v];$(voa 2 1000)" -i $KEEP -loop 1 -t 8 -i $A -i $VO/07-hood.mp3
# 8. Close (7 s), VO 08 at 0.5 s.
render 08-close 7 "[0:v]${FIT}[v];$(voa 1 500)" -loop 1 -t 7 -i $C/close.png -i $VO/08-close.mp3

ls $S/*.mp4 | sed "s|^|file '|; s|$|'|" > $OUT/list.txt
ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i $OUT/list.txt -vf fps=25 -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 160k -movflags +faststart $OUT/HomeLedger-demo.mp4
printf "TOTAL %s\n" $(ffprobe -v error -show_entries format=duration -of csv=p=0 $OUT/HomeLedger-demo.mp4)
