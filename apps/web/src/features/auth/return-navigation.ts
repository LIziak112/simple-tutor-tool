export function loginPathWithReturnTo(
  loginPath: string,
  returnTo: string | null,
) {
  return returnTo
    ? `${loginPath}?${new URLSearchParams({ returnTo })}`
    : loginPath;
}
