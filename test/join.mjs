// node test/join.mjs out.mp4 in1.mp4 in2.mp4 ...  — runs the app's joiner on files.
import fs from 'node:fs';
import { joinMp4 } from '../mp4join.js';

const [out, ...ins] = process.argv.slice(2);
const blobs = await Promise.all(ins.map((p) => fs.openAsBlob(p)));
const t0 = performance.now();
const joined = await joinMp4(blobs);
const ms = (performance.now() - t0).toFixed(1);
const ws = fs.createWriteStream(out);
for await (const chunk of joined.stream()) ws.write(chunk);
ws.end();
console.log(`joined ${ins.length} clips -> ${out} (${joined.size} bytes, ${ms} ms)`);
