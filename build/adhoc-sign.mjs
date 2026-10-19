// Apple Silicon refuses to open an Electron bundle whose seal is broken ("damaged"), even when it is
// unsigned. Re-seal the whole bundle ad hoc (no developer identity, no network timestamp).
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export default async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], {
    stdio: 'inherit',
  });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
}
