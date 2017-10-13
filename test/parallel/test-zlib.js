'use strict';
const common = require('../common');
const assert = require('assert');
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');
const stream = require('stream');

let zlibPairs = [
  [zlib.Deflate, zlib.Inflate],
  [zlib.Gzip, zlib.Gunzip],
  [zlib.Deflate, zlib.Unzip],
  [zlib.Gzip, zlib.Unzip],
  [zlib.DeflateRaw, zlib.InflateRaw]
];

// how fast to trickle through the slowstream
let trickle = [128, 1024, 1024 * 1024];

// tunable options for zlib classes.

// several different chunk sizes
let chunkSize = [128, 1024, 1024 * 16, 1024 * 1024];

// this is every possible value.
let level = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
let windowBits = [8, 9, 10, 11, 12, 13, 14, 15];
let memLevel = [1, 2, 3, 4, 5, 6, 7, 8, 9];
let strategy = [0, 1, 2, 3, 4];

// it's nice in theory to test every combination, but it
// takes WAY too long.  Maybe a pummel test could do this?
if (!process.env.PUMMEL) {
  trickle = [1024];
  chunkSize = [1024 * 16];
  level = [6];
  memLevel = [8];
  windowBits = [15];
  strategy = [0];
}

let testFiles = ['person.jpg', 'elipses.txt', 'empty.txt'];

if (process.env.FAST) {
  zlibPairs = [[zlib.Gzip, zlib.Unzip]];
  testFiles = ['person.jpg'];
}

const tests = {};
testFiles.forEach(common.mustCall((file) => {
  tests[file] = fs.readFileSync(path.resolve(common.fixturesDir, file));
}, testFiles.length));


// stream that saves everything
class BufferStream extends stream.Stream {
  constructor() {
    super();
    this.chunks = [];
    this.length = 0;
    this.writable = true;
    this.readable = true;
  }

  write(c) {
    this.chunks.push(c);
    this.length += c.length;
    return true;
  }

  end(c) {
    if (c) this.write(c);
    // flatten
    const buf = Buffer.allocUnsafe(this.length);
    let i = 0;
    this.chunks.forEach((c) => {
      c.copy(buf, i);
      i += c.length;
    });
    this.emit('data', buf);
    this.emit('end');
    return true;
  }
}

class SlowStream extends stream.Stream {
  constructor(trickle) {
    super();
    this.trickle = trickle;
    this.offset = 0;
    this.readable = this.writable = true;
  }

  write() {
    throw new Error('not implemented, just call ss.end(chunk)');
  }

  pause() {
    this.paused = true;
    this.emit('pause');
  }

  resume() {
    const emit = () => {
      if (this.paused) return;
      if (this.offset >= this.length) {
        this.ended = true;
        return this.emit('end');
      }
      const end = Math.min(this.offset + this.trickle, this.length);
      const c = this.chunk.slice(this.offset, end);
      this.offset += c.length;
      this.emit('data', c);
      process.nextTick(emit);
    };

    if (this.ended) return;
    this.emit('resume');
    if (!this.chunk) return;
    this.paused = false;
    emit();
  }

  end(chunk) {
    // walk over the chunk in blocks.
    this.chunk = chunk;
    this.length = chunk.length;
    this.resume();
    return this.ended;
  }
}

// windowBits: 8 shouldn't throw
assert.doesNotThrow(() => {
  zlib.createDeflateRaw({ windowBits: 8 });
}, 'windowsBits set to 8 should follow legacy zlib behavior');

{
  const node = fs.createReadStream(process.execPath);
  const raw = [];
  const reinflated = [];
  node.on('data', (chunk) => raw.push(chunk));

  // Usually, the inflate windowBits parameter needs to be at least the
  // value of the matching deflate’s windowBits. However, inflate raw with
  // windowBits = 8 should be able to handle compressed data from a source
  // that does not know about the silent 8-to-9 upgrade of windowBits
  // that older versions of zlib/Node perform.
  node.pipe(zlib.createDeflateRaw({ windowBits: 9 }))
      .pipe(zlib.createInflateRaw({ windowBits: 8 }))
      .on('data', (chunk) => reinflated.push(chunk))
      .on('end', common.mustCall(
        () => assert(Buffer.concat(raw).equals(Buffer.concat(reinflated)))));
}

// for each of the files, make sure that compressing and
// decompressing results in the same data, for every combination
// of the options set above.

const testKeys = Object.keys(tests);
testKeys.forEach(common.mustCall((file) => {
  const test = tests[file];
  chunkSize.forEach(common.mustCall((chunkSize) => {
    trickle.forEach(common.mustCall((trickle) => {
      windowBits.forEach(common.mustCall((windowBits) => {
        level.forEach(common.mustCall((level) => {
          memLevel.forEach(common.mustCall((memLevel) => {
            strategy.forEach(common.mustCall((strategy) => {
              zlibPairs.forEach(common.mustCall((pair) => {
                const Def = pair[0];
                const Inf = pair[1];
                const opts = { level: level,
                               windowBits: windowBits,
                               memLevel: memLevel,
                               strategy: strategy };

                const def = new Def(opts);
                const inf = new Inf(opts);
                const ss = new SlowStream(trickle);
                const buf = new BufferStream();

                // verify that the same exact buffer comes out the other end.
                buf.on('data', common.mustCall((c) => {
                  const msg = `${file} ${chunkSize} ${
                    JSON.stringify(opts)} ${Def.name} -> ${Inf.name}`;
                  let i;
                  for (i = 0; i < Math.max(c.length, test.length); i++) {
                    if (c[i] !== test[i]) {
                      assert.fail(null, null, msg);
                      break;
                    }
                  }
                }));

                // the magic happens here.
                ss.pipe(def).pipe(inf).pipe(buf);
                ss.end(test);
              }, zlibPairs.length));
            }, strategy.length));
          }, memLevel.length));
        }, level.length));
      }, windowBits.length));
    }, trickle.length));
  }, chunkSize.length));
}, testKeys.length));
