// テスト用: Cloudflare R2 バケット（env.ATTACHMENTS）のインメモリ代役。
// 外部パッケージは使わない（この製品のnpm依存は wrangler だけ）。
//
// 本物のR2に合わせてある点
//   ・get() が返すオブジェクトは body（ReadableStream）を1本持つ。Workerはこれをそのまま流す
//   ・存在しないキーの get()/head() は null（例外ではない）
//   ・httpMetadata / customMetadata を put のときに受け取り、get/head で返す

function toBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(0));
  return new TextEncoder().encode(String(value));
}

function makeObject(key, entry) {
  return {
    key,
    size: entry.bytes.byteLength,
    httpMetadata: entry.httpMetadata,
    customMetadata: entry.customMetadata,
    // 読むたびに新しいストリームを作る（本物も1オブジェクト1回読み切り）
    get body() {
      return new ReadableStream({
        start(controller) {
          controller.enqueue(entry.bytes);
          controller.close();
        },
      });
    },
    async arrayBuffer() {
      return entry.bytes.buffer.slice(
        entry.bytes.byteOffset, entry.bytes.byteOffset + entry.bytes.byteLength
      );
    },
    async text() {
      return new TextDecoder().decode(entry.bytes);
    },
  };
}

export function createTestR2() {
  const store = new Map();
  return {
    async put(key, value, options = {}) {
      const entry = {
        bytes: toBytes(value),
        httpMetadata: options.httpMetadata ?? {},
        customMetadata: options.customMetadata ?? {},
      };
      store.set(key, entry);
      return { key, size: entry.bytes.byteLength };
    },
    async get(key) {
      const entry = store.get(key);
      return entry ? makeObject(key, entry) : null;
    },
    // headは中身を返さない（サイズとメタデータだけ）
    async head(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        key,
        size: entry.bytes.byteLength,
        httpMetadata: entry.httpMetadata,
        customMetadata: entry.customMetadata,
      };
    },
    async delete(key) {
      store.delete(key);
    },
    // 検査用（R2本体には無い）
    __store: store,
  };
}
