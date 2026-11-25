/**
 * What a picture says about itself (mediaEmbedded), read from its XMP, its IPTC and its EXIF, in that order of trust.
 * `credit` is the credit line, else the creator; `license` the usage terms, else the copyright notice ; `takenAt` with an offset where the file names one, local time where not. Also the copyright notice
 * alone and the two addresses Google Images reads for its Licensable badge: the license (`licenseUrl`, XMP's
 * WebStatement) and where to get one (`acquireLicenseUrl`, PLUS's LicensorURL).
 */
export type EmbeddedFields = {
  credit?: string;
  license?: string;
  caption?: string;
  takenAt?: string;
  copyright?: string;
  licenseUrl?: string;
  acquireLicenseUrl?: string;
};

/** Each fact apart, as the metadata holds it: the fresh XMP a cleaned file keeps is written from these. */
export type Facts = {
  creator?: string;
  creditLine?: string;
  copyright?: string;
  terms?: string;
  licenseUrl?: string;
  acquireLicenseUrl?: string;
  caption?: string;
  takenAt?: string;
};

/** The metadata blocks one file carries, each null where it has none. */
export type Blocks = {
  tiff: Uint8Array | null;
  xmp: string | null;
  iptc: Uint8Array | null;
  text: Record<string, string>;
};

export const NONE: Blocks = { tiff: null, xmp: null, iptc: null, text: {} };
