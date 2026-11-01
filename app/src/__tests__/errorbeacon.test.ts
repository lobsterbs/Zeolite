import { describe, expect, it } from "vitest";

/* #580: the error-beacon classifier - the page's own error pipeline
   reports through fetch/XHR beacons the console hook cannot see, so
   the export must show them in the diag stream. The classifier stays
   deliberately narrow: the two shapes observed in the Google AI Mode
   export only. */

import { isErrorBeaconUrl } from "../request";

describe("isErrorBeaconUrl (#580)", () => {
  it("matches the jserror endpoint at any path depth", () => {
    expect(isErrorBeaconUrl("https://www.google.com/httpservice/retry/jserror")).toBe(true);
    expect(isErrorBeaconUrl("https://www.google.com/jserror")).toBe(true);
    expect(isErrorBeaconUrl("https://www.example.com/jserror?foo=1")).toBe(true);
  });

  it("matches gen_204 only when a non-empty err parameter rides along", () => {
    expect(isErrorBeaconUrl("https://www.google.com/gen_204?err=x&rs=1")).toBe(true);
    expect(isErrorBeaconUrl("https://www.google.com/gen_204?atyp=csi&err=TypeError")).toBe(true);
    /* a plain CSI beacon without err is NOT an error beacon */
    expect(isErrorBeaconUrl("https://www.google.com/gen_204?atyp=csi")).toBe(false);
    expect(isErrorBeaconUrl("https://www.google.com/gen_204?err=")).toBe(false);
    expect(isErrorBeaconUrl("https://www.google.com/gen_204")).toBe(false);
  });

  it("refuses everything else", () => {
    expect(isErrorBeaconUrl("https://www.google.com/search?q=x")).toBe(false);
    expect(isErrorBeaconUrl("https://www.google.com/_/mss/search-next/_/js/k=x")).toBe(false);
    expect(isErrorBeaconUrl("not a url")).toBe(false);
    expect(isErrorBeaconUrl("")).toBe(false);
  });
});
