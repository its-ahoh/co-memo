import { execFile } from 'node:child_process';

/** Use an argument array, never a shell, when handing a loopback URL to the OS. */
export function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'rundll32.exe'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10_000 }, (error) => (error ? reject(error) : resolve()));
  });
}
