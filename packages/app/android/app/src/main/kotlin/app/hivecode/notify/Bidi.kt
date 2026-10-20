package app.hivecode.notify

/**
 * The app's bidi rules (lib/ui/bidi.dart) for text Android draws itself: notification titles and
 * bodies, the summary lines and the widget. Same two steps as in Flutter:
 *  1. Direction per line: first strong letter outside code and URLs; a line that starts with a
 *     Latin token but is mostly Hebrew ("t2790 סיים", "CI נכשל") is Hebrew. The line gets a leading
 *     RLM or LRM so Android's first-strong heuristic lands on the same answer.
 *  2. In Hebrew lines only, LTR runs (paths, ids, versions, times, `PR #17`, English phrases,
 *     numbers with units) are wrapped in LRI…PDI, so the punctuation and brackets around them stay
 *     where Hebrew expects them, and kept whole across line breaks.
 * The patterns are the same text as kBidiPatterns in bidi.dart (test/bidi_test.dart compares them).
 * They use explicit ASCII classes: on Android's ICU engine \w, \d and \b match every script.
 */
object Bidi {
    const val LRI = "\u2066"
    const val FSI = "\u2068"
    const val PDI = "\u2069"
    const val LRM = "\u200E"
    const val RLM = "\u200F"
    const val WJ = "\u2060"

    private fun heb(c: Int) = (c in 0x0590..0x08FF) || (c in 0xFB1D..0xFDFF) || (c in 0xFE70..0xFEFF)
    private fun lat(c: Int) = (c in 0x41..0x5A) || (c in 0x61..0x7A) || (c in 0xC0..0x24F)

    // BEGIN shared patterns
    private const val NON_VOTING = """`[^`\n]*`?|\]\([^) \t\n]*\)|https?://[^ \t\n]+"""
    private const val HEB_WORD = """[\u0590-\u05FF\uFB1D-\uFB4F]+"""
    private const val LAT_WORD = """[A-Za-z\u00C0-\u024F][A-Za-z0-9\u00C0-\u024F]*"""
    private const val TOK = """(?:(?<=^|[ \t])--?)?(?<![A-Za-z0-9_\u00C0-\u024F])(?:[0-9]+[:.])*[A-Za-z0-9_\u00C0-\u024F~@/.$]*[A-Za-z\u00C0-\u024F][A-Za-z0-9_\u00C0-\u024F.:/@#%&=?~+$*|-]*(?<![.,:;!?-])"""
    private const val NUM = """(?:-?[0-9]+(?:[.,:][0-9]+)*)"""
    private const val RUN = """(?:(?:PR|pr) ?#[0-9]+|(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9_.-]*#[0-9]+|TOK)(?:(?:[ ,/&+]| [-\u2013] )+(?:TOK|NUM(?![\u0590-\u05FF])|#[0-9]+))*|(?<![A-Za-z0-9_.])v?[0-9]+(?:\.[0-9]+){2,}(?:[-+][A-Za-z0-9_.]+)?|(?<![0-9.,])[0-9]+(?:[.,][0-9]+)?(?:[ ]?[\u2013-][ ]?[0-9]+(?:[.,][0-9]+)?)?[ ]?(?:ms|\u00B5s|ns|s|sec|min|h|MB|GB|KB|TB|kB|B|px|dp|sp|pt|Hz|fps|x|K|M)(?![A-Za-z0-9_])|#[0-9]+"""
    private const val BREAK_AFTER = """[-/\u2010](?!$)"""
    private const val PREFIX = """((?:^|(?<=[^\u05D0-\u05EA]))[\u05D0-\u05EA]{1,3}[-\u05BE])(?=[\u2066\u2068])"""
    // END shared patterns

    private fun p(s: String) = Regex(s.replace("TOK", TOK).replace("NUM", NUM))
    private val nonVoting = p(NON_VOTING)
    private val hebWord = p(HEB_WORD)
    private val latWord = p(LAT_WORD)
    private val run = p(RUN)
    private val breakAfter = p(BREAK_AFTER)
    private val prefix = p(PREFIX)
    private val code = Regex("`([^`]+)`")

    fun isRtl(line: String): Boolean {
        for (c in line.codePoints()) {
            if (c == 0x200F) return true
            if (c == 0x200E) return false
            if (c == 0x60 || heb(c) || lat(c) || c in 0x30..0x39) break
        }
        val plain = line.replace(nonVoting, " ")
        val first = plain.codePoints().filter { heb(it) || lat(it) }.findFirst()
        if (!first.isPresent) {
            val any = line.codePoints().filter { heb(it) || lat(it) }.findFirst()
            return !any.isPresent || heb(any.asInt)
        }
        if (heb(first.asInt)) return true
        return hebWord.findAll(plain).count() >= latWord.findAll(plain).count()
    }

    /** A path, URL or id stays whole: a word joiner after each hyphen and slash. */
    fun keepWhole(token: String): String = if (' ' in token) token else token.replace(breakAfter) { it.value + WJ }

    /** Isolates the LTR runs of one Hebrew line. Code spans lose their backticks and become FSI runs. */
    fun isolate(line: String): String {
        if (line.codePoints().noneMatch { heb(it) }) return line
        val out = StringBuilder()
        var i = 0
        for (m in code.findAll(line)) {
            out.append(line.substring(i, m.range.first).replace(run) { "$LRI${keepWhole(it.value)}$PDI" })
            out.append(FSI).append(keepWhole(m.groupValues[1])).append(PDI)
            i = m.range.last + 1
        }
        out.append(line.substring(i).replace(run) { "$LRI${keepWhole(it.value)}$PDI" })
        return out.toString().replace(prefix) { it.groupValues[1] + WJ }
    }

    /**
     * Every line marked with its direction. Only RTL lines get their LTR runs isolated: in an
     * English line the isolates would be ordered by the Hebrew quoted inside it.
     */
    fun display(text: String): String = text.lines().joinToString("\n") { l ->
        when {
            l.isBlank() -> l
            // java.util.regex recurses once per repetition, so a few KB of English in one Hebrew
            // line can overflow its stack. A notification must never crash over this: fall back to
            // the direction mark alone.
            isRtl(l) -> RLM + try { isolate(l) } catch (_: StackOverflowError) { l }
            else -> LRM + l
        }
    }
}
