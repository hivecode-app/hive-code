// Hebrew/English bidi in one place. Every piece of worker or owner text goes through here.
//
// 1. Paragraph direction (one per line, list item, heading and quote): Unicode P2, except that
//    inline code and URLs do not vote, and when the first strong letter is Latin but at least
//    half the words are Hebrew ("t2790 סיים", "CI נכשל על guard", "Status: הקוד הועבר") the
//    paragraph is Hebrew. On 3,000 real messages 1 in 3 starts with such a token, and writers
//    were adding RLM by hand to fight strict P2. An explicit RLM/LRM at the start still wins.
// 2. Inside an RTL paragraph, LTR runs (identifiers, paths, URLs, versions, times, `PR #17`,
//    `t3711`, numbers with units, English phrases) are wrapped in LRI…PDI, so the punctuation and
//    brackets around them resolve by the Hebrew: a trailing period stays at the end,
//    `(SIGTERM, exit 143)` keeps its brackets the right way round, "ב-prod." reads in order and
//    "05:43Z" stays whole. LTR paragraphs are left alone (see [isolateLtr]).
//
// The Android side (notify/Bidi.kt) uses the same patterns, character for character: they are
// plain ASCII classes (no \w, \d, \b, \s, which mean "any script" on Android's ICU engine) and
// test/bidi_test.dart checks the two files agree. No pattern backtracks exponentially: each
// repetition has one way to match and tokens start only at a word boundary. Long punctuation-only
// runs ("./" × 3,000) are still quadratic, about 250ms, which real messages don't contain.
import 'package:flutter/painting.dart';

const kLRI = '\u2066';
const kRLI = '\u2067';
const kFSI = '\u2068';
const kPDI = '\u2069';
const kLRM = '\u200E';
const kRLM = '\u200F';
const kWJ = '\u2060';

bool isHebrewRune(int r) => (r >= 0x0590 && r <= 0x08FF) || (r >= 0xFB1D && r <= 0xFDFF) || (r >= 0xFE70 && r <= 0xFEFF);
bool isLatinRune(int r) => (r >= 0x41 && r <= 0x5A) || (r >= 0x61 && r <= 0x7A) || (r >= 0xC0 && r <= 0x24F);

/// The shared patterns (same text in Bidi.kt).
const kBidiPatterns = {
  // What does not vote on direction: inline code, markdown link targets, URLs.
  'NON_VOTING': r'`[^`\n]*`?|\]\([^) \t\n]*\)|https?://[^ \t\n]+',
  'HEB_WORD': r'[\u0590-\u05FF\uFB1D-\uFB4F]+',
  'LAT_WORD': r'[A-Za-z\u00C0-\u024F][A-Za-z0-9\u00C0-\u024F]*',
  // One identifier-like token: letters, digits and the inner punctuation of paths, URLs,
  // versions, flags and refs. Starts at a word boundary, never ends on punctuation.
  'TOK': r'(?:(?<=^|[ \t])--?)?(?<![A-Za-z0-9_\u00C0-\u024F])(?:[0-9]+[:.])*[A-Za-z0-9_\u00C0-\u024F~@/.$]*[A-Za-z\u00C0-\u024F][A-Za-z0-9_\u00C0-\u024F.:/@#%&=?~+$*|-]*(?<![.,:;!?-])',
  'NUM': r'(?:-?[0-9]+(?:[.,:][0-9]+)*)',
  // An LTR run: a token or PR ref, then more tokens or numbers joined by spaces, commas, slashes
  // ("Internal error -100", "cities, route, ride"); or a version; or numbers with a unit
  // ("94–119ms"); or a bare #ref.
  'RUN': r'(?:(?:PR|pr) ?#[0-9]+|(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9_.-]*#[0-9]+|TOK)(?:(?:[ ,/&+]| [-\u2013] )+(?:TOK|NUM(?![\u0590-\u05FF])|#[0-9]+))*|(?<![A-Za-z0-9_.])v?[0-9]+(?:\.[0-9]+){2,}(?:[-+][A-Za-z0-9_.]+)?|(?<![0-9.,])[0-9]+(?:[.,][0-9]+)?(?:[ ]?[\u2013-][ ]?[0-9]+(?:[.,][0-9]+)?)?[ ]?(?:ms|\u00B5s|ns|s|sec|min|h|MB|GB|KB|TB|kB|B|px|dp|sp|pt|Hz|fps|x|K|M)(?![A-Za-z0-9_])|#[0-9]+',
  // A token breaks after these, which in a Hebrew line scatters it across two lines.
  'BREAK_AFTER': r'[-/\u2010](?!$)',
  // "ב-", "ל-", "ו-" right before an isolated run.
  'PREFIX': r'((?:^|(?<=[^\u05D0-\u05EA]))[\u05D0-\u05EA]{1,3}[-\u05BE])(?=[\u2066\u2068])',
};

String _p(String name) => kBidiPatterns[name]!.replaceAll('TOK', kBidiPatterns['TOK']!).replaceAll('NUM', kBidiPatterns['NUM']!);

final _nonVoting = RegExp(_p('NON_VOTING'));
final _hebWord = RegExp(_p('HEB_WORD'));
final _latWord = RegExp(_p('LAT_WORD'));
final _run = RegExp(_p('RUN'));
final _breakAfter = RegExp(_p('BREAK_AFTER'));
final _prefix = RegExp(_p('PREFIX'));
final _endsWithPrefix = RegExp(r'(^|[^\u05D0-\u05EA])[\u05D0-\u05EA]{1,3}[-\u05BE]$');
final _controls = RegExp('[\u2060\u2066-\u2069\u200E\u200F\u202A-\u202F]');

/// Direction of one paragraph (a line, list item, heading or quote). Empty or neutral is RTL.
/// Asked several times per line on every rebuild, so recent answers are kept.
TextDirection paragraphDirection(String s) {
  final hit = _dirs.remove(s);
  if (hit != null) return _dirs[s] = hit;
  final d = _direction(s);
  _dirs[s] = d;
  if (_dirs.length > 2000) _dirs.remove(_dirs.keys.first);
  return d;
}

final _dirs = <String, TextDirection>{};

TextDirection _direction(String s) {
  // Explicit marks first (P2 sees RLM/LRM as strong), skipping markdown openers like `**`, `> `.
  for (final r in s.runes) {
    if (r == 0x200F) return TextDirection.rtl;
    if (r == 0x200E) return TextDirection.ltr;
    if (r == 0x60 || isHebrewRune(r) || isLatinRune(r) || (r >= 0x30 && r <= 0x39)) break;
  }
  final plain = s.replaceAll(_nonVoting, ' ');
  bool? hebrewFirst;
  for (final r in plain.runes) {
    if (isHebrewRune(r)) {
      hebrewFirst = true;
      break;
    }
    if (isLatinRune(r)) {
      hebrewFirst = false;
      break;
    }
  }
  if (hebrewFirst == null) {
    // Only code or a URL: the code's own first strong letter decides (`git status` is LTR).
    for (final r in s.runes) {
      if (isHebrewRune(r)) return TextDirection.rtl;
      if (isLatinRune(r)) return TextDirection.ltr;
    }
    return TextDirection.rtl;
  }
  if (hebrewFirst) return TextDirection.rtl;
  final heb = _hebWord.allMatches(plain).length;
  final lat = _latWord.allMatches(plain).length;
  return heb >= lat ? TextDirection.rtl : TextDirection.ltr;
}

/// Same rule as [paragraphDirection]. The composer uses it too, so what is typed turns the way it
/// will be shown once sent ("t2790" starts LTR and turns RTL when the Hebrew words outnumber it).
TextDirection firstStrongDirection(String s) => paragraphDirection(s);

/// Direction of the last line of [s] (where a bubble's time goes).
TextDirection lastLineDirection(String s) => paragraphDirection(s.trimRight().split('\n').last);

/// Wraps every LTR run of [s] in LRI…PDI. Only for text inside an RTL paragraph: in an LTR
/// paragraph the isolates would turn the English into neutrals ordered by the Hebrew around them.
/// [s] without Hebrew is returned as is unless [force] (a piece of a Hebrew line, like the text
/// between two code spans, has no Hebrew of its own but still sits in an RTL paragraph).
String isolateLtr(String s, {bool force = false}) {
  if (!force && (!s.runes.any(isHebrewRune) || paragraphDirection(s) == TextDirection.ltr)) return s;
  return glueHebrewPrefix(s.replaceAllMapped(_run, (m) => '$kLRI${keepWhole(m[0]!)}$kPDI'));
}

/// A path, URL or id breaks at its hyphens and slashes, which in a Hebrew line scatters it across
/// two lines in an order that reads wrong. A word joiner after each keeps a single token whole;
/// a token longer than the line still breaks, wherever it must.
String keepWhole(String token) => token.contains(' ') ? token : token.replaceAllMapped(_breakAfter, (m) => '${m[0]}$kWJ');

/// "ב-prod", "ו-ios-build": a word joiner after the Hebrew prefix's hyphen when an isolated run
/// follows, so the line never breaks between "ב-" and the word it belongs to.
String glueHebrewPrefix(String s) => s.replaceAllMapped(_prefix, (m) => '${m[1]}$kWJ');

/// True when [s] ends with a Hebrew prefix and hyphen ("ו-"), to glue it to inline code after it.
bool endsWithHebrewPrefix(String s) => _endsWithPrefix.hasMatch(s);

/// The text without the invisible controls this file adds (and the code-box padding). The app
/// copies and searches the source text, so this is for tests and for anything that reads text
/// back off the screen.
String stripBidi(String s) => s.replaceAll(_controls, '');
