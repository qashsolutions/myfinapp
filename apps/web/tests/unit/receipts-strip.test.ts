import {
  ReceiptError,
  readBytes,
  stripJpeg,
  stripMetadata,
  stripPng,
} from "../../src/data/receipts.ts";

function seg(marker: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload];
}

const EXIF_WITH_GPS = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x47, 0x50, 0x53, 0x21]; // "Exif\0\0GPS!"
const JFIF = [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
const DQT = seg(0xdb, [0, ...new Array(64).fill(1)]);
const SOF = seg(0xc0, [8, 0, 8, 0, 8, 1, 1, 0x11, 0]);
const DHT = seg(0xc4, [0x00, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x05]);
const SOS_AND_DATA = [...seg(0xda, [1, 1, 0, 0, 63, 0]), 0x12, 0xff, 0x00, 0x34, 0xff, 0xd9];

function jpeg(parts: number[][]): Uint8Array {
  return new Uint8Array([0xff, 0xd8, ...parts.flat()]);
}

describe("receipt photos lose their metadata before they are stored", () => {
  it("drops EXIF, XMP and comment segments from a JPEG and keeps the image segments", () => {
    const input = jpeg([
      seg(0xe0, JFIF),
      seg(0xe1, EXIF_WITH_GPS),
      seg(0xe1, [0x68, 0x74, 0x74, 0x70, 0x3a]), // XMP ("http:")
      seg(0xfe, [0x68, 0x69]), // comment
      DQT,
      seg(0xed, [0x50, 0x68, 0x6f, 0x74]), // Photoshop IPTC
      SOF,
      DHT,
      SOS_AND_DATA,
    ]);
    const expected = jpeg([seg(0xe0, JFIF), DQT, SOF, DHT, SOS_AND_DATA]);
    expect(Array.from(stripJpeg(input))).toEqual(Array.from(expected));
    expect(Array.from(stripJpeg(input))).not.toContain(0x47); // the "G" of GPS is gone
  });

  it("keeps APP14 (Adobe) so colours stay right, and a JPEG without metadata is unchanged", () => {
    const adobe = seg(0xee, [0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, 1]);
    const input = jpeg([adobe, DQT, SOF, DHT, SOS_AND_DATA]);
    expect(Array.from(stripJpeg(input))).toEqual(Array.from(input));
  });

  it("drops eXIf, text and time chunks from a PNG and keeps IHDR, IDAT and IEND", () => {
    const chunk = (type: string, data: number[]) => [
      (data.length >>> 24) & 0xff,
      (data.length >>> 16) & 0xff,
      (data.length >>> 8) & 0xff,
      data.length & 0xff,
      ...type.split("").map((c) => c.charCodeAt(0)),
      ...data,
      0,
      0,
      0,
      0, // crc (not checked)
    ];
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const ihdr = chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
    const text = chunk("tEXt", [0x41, 0x00, 0x42]);
    const exif = chunk("eXIf", [0x47, 0x50, 0x53]);
    const time = chunk("tIME", [7, 234, 10, 10, 12, 0, 0]);
    const idat = chunk("IDAT", [0x78, 0x9c, 0x63, 0x60, 0, 0, 0, 2, 0, 1]);
    const iend = chunk("IEND", []);
    const input = new Uint8Array([
      ...signature,
      ...ihdr,
      ...text,
      ...exif,
      ...idat,
      ...time,
      ...iend,
    ]);
    const expected = new Uint8Array([...signature, ...ihdr, ...idat, ...iend]);
    expect(Array.from(stripPng(input))).toEqual(Array.from(expected));
  });

  it("refuses bytes that are not a photo, and routes JPEG and PNG by their signature", async () => {
    expect(() => stripJpeg(new Uint8Array([1, 2, 3]))).toThrow(ReceiptError);
    expect(() => stripPng(new Uint8Array([1, 2, 3]))).toThrow(ReceiptError);
    const file = new File(
      [jpeg([seg(0xe1, EXIF_WITH_GPS), DQT, SOF, DHT, SOS_AND_DATA]).buffer as ArrayBuffer],
      "r.jpg",
      { type: "image/jpeg" },
    );
    const clean = await stripMetadata(file);
    expect(clean.type).toBe("image/jpeg");
    expect(Array.from(await readBytes(clean))).toEqual(
      Array.from(jpeg([DQT, SOF, DHT, SOS_AND_DATA])),
    );
    await expect(
      stripMetadata(new File([new Uint8Array([0, 1, 2]).buffer as ArrayBuffer], "x.heic")),
    ).rejects.toMatchObject({ code: "unsupported" });
  });
});
