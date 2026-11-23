const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const coordinatePattern = /\b-?\d{1,3}\.\d{2,}\s*,\s*-?\d{1,3}\.\d{2,}\b/g;
const labeledCoordinatePattern = /\b(?:lat|latitude)\s*[:=]\s*-?\d{1,3}(?:\.\d+)?\s*[,; ]+\s*(?:lon|lng|longitude)\s*[:=]?\s*-?\d{1,3}(?:\.\d+)?\b/gi;
const cookieHeaderPattern = /\b(?:set-cookie|cookie)\s*[:=]\s*[^\r\n]*/gi;
const authorizationPattern = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]+=*/gi;
const labeledCredentialPattern = /\b(?:password|passwd|passphrase|pwd|api[\s_-]?key|secret|access[_-]?token|refresh[_-]?token|auth(?:orization)?|session(?:[_-]?id)?|username)\s*(?::|=|\bis\b)\s*[^\s,;]+/gi;
const jwtPattern = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const apiKeyPattern = /\b(?:AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{16,})\b/g;
const aadhaarPattern = /\b\d{4}(?:[\s-]?\d{4}){2}\b/g;
const panPattern = /\b[A-Z]{5}\d{4}[A-Z]\b/gi;
const ssnPattern = /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g;
const vehicleRegistrationPattern = /\b[A-Z]{2}[- ]?\d{1,2}[A-Z]{1,3}(?:[- ]+[A-Z]{1,3})?[- ]?\d{4}\b/gi;
const streetAddressPattern = /\b\d{1,6}\s+(?:[A-Z0-9][A-Z0-9.'-]*\s+){0,4}(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|court|ct|way|place|pl|highway|hwy)\b(?:\s*(?:,|#|-)\s*[A-Z0-9][A-Z0-9.' -]{0,40})?/gi;
const phoneCandidatePattern = /(^|[^\w])(\+?\d[\d\s().-]{6,}\d)(?=$|[^\w])/g;
const urlPattern = /https?:\/\/[^\s<>"']+/gi;
const sensitiveQueryParameter = /^(?:utm_.+|gclid|dclid|fbclid|msclkid|mc_cid|mc_eid|email|phone|mobile|address|lat|latitude|lon|lng|longitude|gps|token|access_token|refresh_token|auth|authorization|password|secret|api_key|cookie|session|sessionid|user|username|uid|user_id)$/i;

function stripSensitiveUrlParameters(value: string) {
  return value.replace(urlPattern, (candidate) => {
    const trailingPunctuation = candidate.match(/[).,!?:;]+$/)?.[0] ?? '';
    const rawUrl = trailingPunctuation ? candidate.slice(0, -trailingPunctuation.length) : candidate;
    try {
      const url = new URL(rawUrl);
      for (const key of [...url.searchParams.keys()]) {
        if (sensitiveQueryParameter.test(key)) url.searchParams.delete(key);
      }
      if (/(?:access_token|auth|email|gps|lat|lng|lon|session|token|user|utm_)/i.test(url.hash)) {
        url.hash = '';
      }
      return `${url.toString()}${trailingPunctuation}`;
    } catch {
      return '[link removed]';
    }
  });
}

export function sanitizeSensitiveText(value: string, maxLength = 2_000) {
  const maximum = Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : 2_000;
  return stripSensitiveUrlParameters(value
    .replace(cookieHeaderPattern, '[credential removed]')
    .replace(authorizationPattern, '[credential removed]')
    .replace(labeledCredentialPattern, '[credential removed]')
    .replace(jwtPattern, '[credential removed]')
    .replace(apiKeyPattern, '[credential removed]')
    .replace(labeledCoordinatePattern, '[location removed]')
    .replace(coordinatePattern, '[location removed]')
    .replace(aadhaarPattern, '[identification number removed]')
    .replace(panPattern, '[identification number removed]')
    .replace(ssnPattern, '[identification number removed]')
    .replace(vehicleRegistrationPattern, '[vehicle identifier removed]')
    .replace(emailPattern, '[contact details removed]')
    .replace(phoneCandidatePattern, (match, prefix: string, candidate: string) => {
      const digitCount = candidate.replace(/\D/g, '').length;
      return digitCount >= 10 && digitCount <= 15
        ? `${prefix}[contact details removed]`
        : match;
    })
    .replace(streetAddressPattern, '[address removed]')
  ).slice(0, maximum);
}
