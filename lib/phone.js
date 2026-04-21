// E.164 phone normalisation for TrackMyGigs.
//
// Phase IX adds a Find Musicians directory with exact-match lookup by phone
// number. For that lookup to work, "07700 900123", "+44 7700 900123" and
// "447700900123" all need to collapse to the same canonical string. That is
// E.164 format: a leading "+", country code, subscriber number, digits only,
// no spaces or punctuation.
//
// Default country is the UK (+44) because that is the launch audience. Users
// who type a full "+countrycode..." number for any country have their input
// respected — we just strip punctuation and validate the length.
//
// The return value is either a canonical string like "+447700900123" or null
// if the input cannot be parsed into a plausible phone number. Null is also
// the right answer for empty input; callers do not need to pre-check.

function normaliseE164(input, defaultCountry = 'GB') {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;

  // Strip spaces, hyphens, parentheses, periods. Keep the leading + if present.
  s = s.replace(/[\s\-().]/g, '');
  if (!s) return null;

  // "00" international prefix becomes "+".
  if (s.startsWith('00')) s = '+' + s.slice(2);

  // Already in + form. Validate the rest is 8-15 digits (E.164 max length is
  // 15 digits after the country code indicator).
  if (s.startsWith('+')) {
    const digits = s.slice(1);
    if (!/^\d{8,15}$/.test(digits)) return null;
    return '+' + digits;
  }

  // No leading + or 00. Apply the default-country rules.
  if (defaultCountry === 'GB') {
    // Leading 0 is the UK trunk prefix. Drop it and prepend +44. UK subscriber
    // numbers after the trunk prefix are 9 or 10 digits depending on area.
    if (s.startsWith('0')) {
      const rest = s.slice(1);
      if (!/^\d{9,10}$/.test(rest)) return null;
      return '+44' + rest;
    }
    // User typed the country code without the +, e.g. "447700900123".
    if (/^44\d{9,10}$/.test(s)) return '+' + s;
    // User typed just the mobile subscriber number, e.g. "7700900123".
    // Only accept the 10-digit UK mobile pattern (starts with 7) to avoid
    // misparsing short strings.
    if (/^7\d{9}$/.test(s)) return '+44' + s;
    return null;
  }

  // Non-GB default with no explicit country code in the input: only accept
  // something that already looks like a raw international number.
  if (/^\d{8,15}$/.test(s)) return '+' + s;
  return null;
}

module.exports = { normaliseE164 };
