export const REQUEST_ID_HEADER = "x-request-id";
export const BUILD_VERSION_HEADER = "x-build-version";

export type RequestDiagnostics = {
  readonly requestId: string | null;
  readonly buildVersion: string | null;
};

const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const buildVersionPattern = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}$/;

export function parseBuildVersion(value?: string | null): string | null {
  return value != null && buildVersionPattern.test(value) ? value : null;
}

export function responseDiagnosticsOf(headers: {
  get(name: string): string | null;
}): RequestDiagnostics {
  const requestId = headers.get(REQUEST_ID_HEADER);
  return {
    requestId:
      requestId !== null && requestIdPattern.test(requestId) ? requestId : null,
    buildVersion: parseBuildVersion(headers.get(BUILD_VERSION_HEADER)),
  };
}
