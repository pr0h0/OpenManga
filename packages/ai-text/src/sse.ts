/** Calls `onData` with each `data:` payload of a server-sent event stream, in order, until the stream ends. */
export async function readSseData(res: Response, onData: (payload: string) => void) {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) onData(line.slice(5).trim());
      nl = buf.indexOf("\n");
    }
  }
  if (buf.trim().startsWith("data:")) onData(buf.trim().slice(5).trim());
}
