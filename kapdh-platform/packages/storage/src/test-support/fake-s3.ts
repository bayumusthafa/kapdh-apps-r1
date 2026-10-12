import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Server S3 tiruan minimal (path-style) untuk menguji S3Driver tanpa jaringan: PutObject, CopyObject, GetObject,
 * HeadObject, DeleteObject. Bucket `bucket-rusak` selalu menjawab 403 AccessDenied untuk menguji penerusan galat.
 * Hanya untuk uji; tidak dikompilasi ke dist (tsconfig exclude).
 */
export interface FakeS3 {
  url: string;
  objects: Map<string, { body: Buffer; contentType: string; modifiedAt: Date }>;
  close(): Promise<void>;
}

function xmlError(res: ServerResponse, status: number, code: string, key = ""): void {
  res.writeHead(status, { "content-type": "application/xml" });
  res.end(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message>` +
      `<Key>${key}</Key><RequestId>uji</RequestId></Error>`,
  );
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function startFakeS3(): Promise<FakeS3> {
  const objects: FakeS3["objects"] = new Map();
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = decodeURIComponent(url.pathname.replace(/^\//, ""));
      const bucket = path.split("/")[0] ?? "";
      if (bucket === "bucket-rusak") return xmlError(res, 403, "AccessDenied");
      const etag = (body: Buffer) => `"${createHash("md5").update(body).digest("hex")}"`;
      switch (req.method) {
        case "PUT": {
          const source = req.headers["x-amz-copy-source"];
          if (typeof source === "string") {
            const from = objects.get(decodeURIComponent(source.replace(/^\//, "")));
            await readBody(req);
            if (!from) return xmlError(res, 404, "NoSuchKey");
            objects.set(path, { ...from, modifiedAt: new Date() });
            res.writeHead(200, { "content-type": "application/xml" });
            res.end(
              `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><LastModified>${new Date().toISOString()}` +
                `</LastModified><ETag>${etag(from.body)}</ETag></CopyObjectResult>`,
            );
            return;
          }
          const body = await readBody(req);
          objects.set(path, {
            body,
            contentType: String(req.headers["content-type"] ?? "application/octet-stream"),
            modifiedAt: new Date(),
          });
          res.writeHead(200, { etag: etag(body) });
          res.end();
          return;
        }
        case "GET":
        case "HEAD": {
          const object = objects.get(path);
          if (!object) {
            if (req.method === "HEAD") {
              res.writeHead(404);
              res.end();
              return;
            }
            return xmlError(res, 404, "NoSuchKey", path);
          }
          res.writeHead(200, {
            "content-type": object.contentType,
            "content-length": String(object.body.byteLength),
            "last-modified": object.modifiedAt.toUTCString(),
            etag: etag(object.body),
          });
          res.end(req.method === "GET" ? object.body : undefined);
          return;
        }
        case "DELETE":
          objects.delete(path);
          res.writeHead(204);
          res.end();
          return;
        default:
          return xmlError(res, 405, "MethodNotAllowed");
      }
    })().catch(() => xmlError(res, 500, "InternalError"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    objects,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
