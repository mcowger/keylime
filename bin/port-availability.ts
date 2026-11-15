import net from "node:net";

export function isPortAvailable(
  port: string | number,
  hostname?: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const server = net.createServer();

    server.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        resolve(false);
      } else {
        reject(error);
      }
    });

    server.listen({ port: Number(port), host: hostname }, () => {
      server.close((error) => {
        if (error) reject(error);
        else resolve(true);
      });
    });
  });
}
