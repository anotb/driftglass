export interface ZipFileInput {
  name: string;
  data: string | Uint8Array;
}

const encoder = new TextEncoder();

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? encoder.encode(value) : value;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

let crcTable: Uint32Array | undefined;
function table(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    crcTable[index] = value >>> 0;
  }
  return crcTable;
}

export function crc32(input: Uint8Array): number {
  let crc = 0xffffffff;
  const lookup = table();
  for (const value of input) crc = (crc >>> 8) ^ lookup[(crc ^ value) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function localHeader(name: Uint8Array, data: Uint8Array, crc: number, stamp: { time: number; date: number }): Uint8Array {
  const output = new Uint8Array(30 + name.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, stamp.time, true);
  view.setUint16(12, stamp.date, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, data.byteLength, true);
  view.setUint32(22, data.byteLength, true);
  view.setUint16(26, name.byteLength, true);
  view.setUint16(28, 0, true);
  output.set(name, 30);
  return output;
}

function centralHeader(
  name: Uint8Array,
  data: Uint8Array,
  crc: number,
  stamp: { time: number; date: number },
  localOffset: number,
): Uint8Array {
  const output = new Uint8Array(46 + name.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, stamp.time, true);
  view.setUint16(14, stamp.date, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, data.byteLength, true);
  view.setUint32(24, data.byteLength, true);
  view.setUint16(28, name.byteLength, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, localOffset, true);
  output.set(name, 46);
  return output;
}

export function createStoredZip(files: ZipFileInput[], modifiedAt = new Date()): Uint8Array {
  const stamp = dosDateTime(modifiedAt);
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const file of files) {
    const normalized = file.name.replaceAll("\\", "/").replace(/^\/+/, "");
    if (!normalized || normalized.includes("../")) throw new Error(`Unsafe ZIP path: ${file.name}`);
    const name = encoder.encode(normalized);
    const data = bytes(file.data);
    const crc = crc32(data);
    const header = localHeader(name, data, crc, stamp);
    localParts.push(header, data);
    centralParts.push(centralHeader(name, data, crc, stamp, localOffset));
    localOffset += header.byteLength + data.byteLength;
  }
  const central = concat(centralParts);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, files.length, true);
  view.setUint16(10, files.length, true);
  view.setUint32(12, central.byteLength, true);
  view.setUint32(16, localOffset, true);
  view.setUint16(20, 0, true);
  return concat([...localParts, central, end]);
}
