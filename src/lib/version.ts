/**
 * Which build of the site this is.
 *
 * The version is set by hand in package.json. The build number is the commit
 * count, which a global pre-commit hook stamps into `build-number.json` on
 * every commit. next.config.ts reads both when the site is built, so a page
 * served from the VPS says which commit it came from without the image
 * holding the git history.
 */
export const VERSION = process.env.APP_VERSION ?? '0.0.0';
export const BUILD = process.env.APP_BUILD ?? '0';

/** `PAC Tracker 1.0.0, build 178`. */
export const VERSION_LABEL = `PAC Tracker ${VERSION}, build ${BUILD}`;
