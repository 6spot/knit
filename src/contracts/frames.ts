/**
 * 传输协议帧切分：增量 UTF-8 解码，只按 LF 切帧。
 * 不用会误切 U+2028/U+2029 的通用 splitlines，也不将每个字节块独立解码。
 * 畸形帧、截断响应或 EOF 不当成功；尾部半行留在缓冲，由调用方按已知对象核实。
 */
export class LfFrameDecoder {
  private buffer = "";
  private readonly decoder = new TextDecoder("utf-8");

  /** 喂入一段字节，返回其中完整帧（不含 LF）。半行保留在内部缓冲。 */
  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const frames: string[] = [];
    let lf = this.buffer.indexOf("\n");
    while (lf !== -1) {
      const line = this.buffer.slice(0, lf);
      if (line !== "") frames.push(line);
      this.buffer = this.buffer.slice(lf + 1);
      lf = this.buffer.indexOf("\n");
    }
    return frames;
  }

  /** 流结束时调用；返回可能存在的尾部半行，由调用方按畸形处理，不自动当完整帧。 */
  end(): string | null {
    const rest = this.decoder.decode();
    const tail = this.buffer + rest;
    this.buffer = "";
    return tail === "" ? null : tail;
  }
}
