// The latest Android build of the app, for the in-app update (GET /api/app/latest, GET /api/app/apk/:code).
// scripts/deploy.sh app writes app-release.json next to the APK in each release dir and swaps the
// `current` symlink; hq reads whatever `current` points at now. The app compares version_code with
// its own, downloads the APK through hq (device token) and checks sha256 before Android installs it.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const RELEASE_FILE = 'app-release.json';

/** What the app sees. apk_path is relative to hq's base URL. */
export interface AppRelease {
  version_code: number;
  version_name: string;
  sha: string;
  sha256: string;
  bytes: number;
  apk_path: string;
}

export interface AppReleaseFile { release: AppRelease; file: string }

export class AppReleases {
  private cache: { key: string; value: AppReleaseFile | null } | null = null;
  private readonly dir: string | null;

  /** dir: the live release (a symlink that deploy swaps), or null when this hq has no app. */
  constructor(dir: string | null) { this.dir = dir; }

  /** Null when there is no release, or it is not one hq can vouch for (missing or mismatched APK). */
  latest(): AppReleaseFile | null {
    if (!this.dir) return null;
    let real: string, mtime: number;
    try {
      real = realpathSync(this.dir);
      mtime = statSync(join(real, RELEASE_FILE)).mtimeMs;
    } catch {
      return null;
    }
    // One release dir never changes after deploy, so the resolved path is the cache key.
    const key = `${real}:${mtime}`;
    if (this.cache?.key !== key) this.cache = { key, value: read(real) };
    return this.cache.value;
  }

  /** The APK of exactly this version, so a deploy mid-download can't hand out a different build. */
  apk(versionCode: number): AppReleaseFile | null {
    const l = this.latest();
    return l && l.release.version_code === versionCode ? l : null;
  }
}

function read(real: string): AppReleaseFile | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(readFileSync(join(real, RELEASE_FILE), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const code = j.version_code, apk = j.apk, sha256 = j.sha256, bytes = j.bytes;
  if (!Number.isSafeInteger(code) || (code as number) <= 0) return null;
  if (typeof apk !== 'string' || !/^[\w.-]+\.apk$/.test(apk)) return null;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (!Number.isSafeInteger(bytes) || (bytes as number) <= 0) return null;
  const file = join(real, apk);
  if (!existsSync(file) || statSync(file).size !== bytes) return null;
  return {
    file,
    release: {
      version_code: code as number,
      version_name: typeof j.version_name === 'string' ? j.version_name : '',
      sha: typeof j.sha === 'string' ? j.sha : '',
      sha256,
      bytes: bytes as number,
      apk_path: `/api/app/apk/${code as number}`,
    },
  };
}
