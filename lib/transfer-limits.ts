/** Maximum on-disk sync or backup file: 1 GiB, excluding HTTP framing. */
export const ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024;
export const UPLOAD_REQUEST_MAX_BYTES = ARCHIVE_MAX_BYTES + 16 * 1024 * 1024;
export const MIDDLEWARE_UPLOAD_MAX_BYTES = ARCHIVE_MAX_BYTES + 32 * 1024 * 1024;
