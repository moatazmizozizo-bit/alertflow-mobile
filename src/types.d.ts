declare var Buffer: {
  from(data: string | number[] | ArrayBuffer, encoding?: string): Buffer;
  alloc(size: number, fill?: number, encoding?: string): Buffer;
  concat(list: Buffer[]): Buffer;
  isBuffer(obj: any): boolean;
};
interface Buffer {
  length: number;
  [index: number]: number;
  toString(encoding?: string, start?: number, end?: number): string;
  slice(start?: number, end?: number): Buffer;
  readUInt16BE(offset: number): number;
  readBigUInt64BE(offset: number): bigint;
  write(string: string, offset?: number, length?: number, encoding?: string): number;
  subarray(start?: number, end?: number): Buffer;
}

declare module '*.wav' {
  const src: number;
  export default src;
}
declare module '*.png' {
  const src: number;
  export default src;
}