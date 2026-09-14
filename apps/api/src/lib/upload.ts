import busboy from 'busboy';
import type { Request } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PayloadTooLargeError, ValidationError } from './errors.js';

export interface UploadedFile {
  /** Temporary path. Callers must `removeUploadedFile` when done. */
  path: string;
  filename: string;
  bytes: number;
  sha256: string;
}

export interface MultipartUpload {
  file: UploadedFile;
  fields: Record<string, string>;
}

const MAX_FIELDS = 20;
const MAX_FIELD_BYTES = 16 * 1024;

/**
 * Stream a single-file multipart upload to a temp file, hashing as it goes.
 * Memory use is constant; the file is rejected once it exceeds `maxBytes`.
 */
export async function receiveMultipartFile(
  req: Request,
  options: { fieldName: string; maxBytes: number },
): Promise<MultipartUpload> {
  let parser: busboy.Busboy;
  try {
    parser = busboy({
      headers: req.headers,
      limits: {
        files: 1,
        fileSize: options.maxBytes,
        fields: MAX_FIELDS,
        fieldSize: MAX_FIELD_BYTES,
      },
    });
  } catch (err) {
    throw new ValidationError('Expected a multipart/form-data upload', [], err);
  }

  const fields: Record<string, string> = {};
  let tempPath: string | undefined;
  let written: Promise<UploadedFile> | undefined;
  // Object so the flag set inside the busboy callback is visible to checks below.
  const limit = { exceeded: false };

  parser.on('field', (name, value) => {
    fields[name] = value;
  });

  parser.on('file', (name, stream, info) => {
    if (name !== options.fieldName || written !== undefined) {
      stream.resume();
      return;
    }
    const path = join(tmpdir(), `cadentor-upload-${randomUUID()}`);
    tempPath = path;
    const hash = createHash('sha256');
    let bytes = 0;
    stream.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    stream.on('limit', () => {
      limit.exceeded = true;
    });
    written = pipeline(stream, createWriteStream(path)).then(() => ({
      path,
      filename: basename(info.filename || 'upload.csv').slice(0, 255),
      bytes,
      sha256: hash.digest('hex'),
    }));
    // Observed below; prevents an unhandled rejection if parsing fails first.
    written.catch(() => undefined);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      parser.on('close', resolve);
      parser.on('error', (err) => {
        reject(new ValidationError('Malformed multipart upload', [], err));
      });
      req.on('error', reject);
      req.pipe(parser);
    });

    if (written === undefined) {
      throw new ValidationError(`Missing "${options.fieldName}" file field`);
    }
    const file = await written;
    if (limit.exceeded) throw new PayloadTooLargeError();
    return { file, fields };
  } catch (err) {
    if (tempPath !== undefined) await removeUploadedFile(tempPath);
    throw err;
  }
}

export async function removeUploadedFile(path: string): Promise<void> {
  // Retries cover Windows keeping a just-closed handle busy briefly.
  await rm(path, { force: true, maxRetries: 5, retryDelay: 50 });
}
