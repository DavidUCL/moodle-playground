/**
 * Small validation helpers shared by blueprint step handlers.
 *
 * Steps import shared code from modules like this one (or php/helpers.js)
 * rather than from sibling step files, so common semantics — what counts as a
 * blank string, what counts as a downloadable URL — cannot drift between steps.
 */

export function trimmedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isHttpUrl(value) {
  return /^https?:\/\//iu.test(value);
}
