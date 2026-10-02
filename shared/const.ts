export const COOKIE_NAME = "resulio_session";
/** Client hint naming the provider workspace to act in; the server verifies ownership. */
export const WORKSPACE_HEADER = "x-resulio-workspace";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = 'Please login (10001)';
export const NOT_ADMIN_ERR_MSG = 'You do not have required permission (10002)';
/** A dismissed dashboard referral card reappears once this many days have passed. */
export const REFERRAL_CARD_SNOOZE_DAYS = 30;
