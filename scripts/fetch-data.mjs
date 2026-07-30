// Download the original IXA containers from the official iXalance archive.
//
// The demo binaries are deliberately not part of this Git repository or its software
// license. Every download is checked against the known-good digest before it is installed.

import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const BASE_URL = 'https://www.libsdl.org/projects/ixalance/data/';
const DATA_DIR = new URL('../data/', import.meta.url);
const FILES = [
  {
    name: 'jizz.ixa',
    sha256: '5c55d364740911715e6ee50fafd1f4a2a88479ed853364b857b0711cb4a0685e',
  },
  {
    name: 'stash.ixa',
    sha256: '87b326631d4ef9f4b4ba2c93c46dd73854666b6213d1c5074cb23f9f92bd9e21',
  },
  {
    name: 'astral.ixa',
    sha256: '4f5326b36ba790bf439921e3d0a48c02e425d48bba617a541ef5be58be49b9fa',
  },
];

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function existingBytes(target) {
  try {
    return await readFile(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function fetchOne(file) {
  const target = fileURLToPath(new URL(file.name, DATA_DIR));
  const existing = await existingBytes(target);
  if (existing) {
    const got = digest(existing);
    if (got !== file.sha256) {
      throw new Error(
        `${file.name} already exists but has SHA-256 ${got}; refusing to overwrite it`,
      );
    }
    process.stdout.write(`verified data/${file.name}\n`);
    return;
  }

  const url = `${BASE_URL}${file.name}`;
  process.stdout.write(`downloading ${url}\n`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} fetching ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const got = digest(bytes);
  if (got !== file.sha256) {
    throw new Error(`${file.name} has SHA-256 ${got}; expected ${file.sha256}`);
  }

  const temporary = `${target}.${process.pid}.${randomUUID()}.part`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  process.stdout.write(`installed data/${file.name} (${bytes.length.toLocaleString()} bytes)\n`);
}

for (const file of FILES) await fetchOne(file);
process.stdout.write(
  'The IXA files are TBL demo assets and are not covered by the repository software license.\n',
);
