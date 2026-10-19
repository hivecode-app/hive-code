package app.hivecode.notify

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Typeface
import androidx.core.content.ContextCompat
import androidx.core.graphics.createBitmap
import androidx.core.graphics.drawable.DrawableCompat
import app.hivecode.R

/**
 * The worker identity of APP-SPEC §6.1 drawn for Android surfaces that cannot run Flutter
 * (notification Person icon, shortcuts, bubbles): first letter in a neutral circle, a dashed ring
 * for temporary workers, and the team icon in a small circle so "ע" of עידו and "ע" of עמית differ.
 */
object Monogram {
    private const val CIRCLE = 0xFFE6E6E2.toInt()
    private const val INK = 0xFF1A1B1D.toInt()
    private const val BADGE = 0xFFFFFFFF.toInt()
    private const val RING = 0xFF8A8B87.toInt()

    /** First real letter of the name: skips quotes, geresh, digits, emoji and niqqud. Latin is upper-cased. */
    fun letter(name: String): String {
        var i = 0
        while (i < name.length) {
            val cp = name.codePointAt(i)
            if (Character.isLetter(cp)) return String(Character.toChars(Character.toUpperCase(cp)))
            i += Character.charCount(cp)
        }
        return "?"
    }

    /** Team icon by the org.yaml `symbol` name (Material Symbols). Unknown names get no badge. */
    fun teamIcon(symbol: String): Int? = when (symbol) {
        "explore" -> R.drawable.ic_ms_explore
        "shield" -> R.drawable.ic_ms_shield
        "folder_shared" -> R.drawable.ic_ms_folder_shared
        "build" -> R.drawable.ic_ms_build
        "local_shipping" -> R.drawable.ic_ms_local_shipping
        "smart_toy" -> R.drawable.ic_ms_smart_toy
        "graphic_eq" -> R.drawable.ic_ms_graphic_eq
        else -> null
    }

    @Volatile private var heebo: Typeface? = null

    /** Heebo 700 from the Flutter asset bundle; the system bold face if it cannot be read. */
    private fun typeface(context: Context): Typeface {
        heebo?.let { return it }
        val tf = try {
            Typeface.createFromAsset(context.assets, "flutter_assets/assets/fonts/Heebo-700.ttf")
        } catch (_: Exception) {
            Typeface.DEFAULT_BOLD
        }
        heebo = tf
        return tf
    }

    /**
     * Everything stays inside the inscribed circle, because Android crops conversation avatars to a
     * circle and a badge in the square's corner would be cut off.
     */
    fun bitmap(context: Context, name: String, symbol: String, ephemeral: Boolean, sizePx: Int = 192): Bitmap {
        val s = sizePx.toFloat()
        val bmp = createBitmap(sizePx, sizePx)
        val c = Canvas(bmp)
        val cx = s / 2f
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)

        val r = if (ephemeral) s * 0.40f else s * 0.46f
        paint.color = CIRCLE
        c.drawCircle(cx, cx, r, paint)
        if (ephemeral) {
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = s * 0.03f
            paint.color = RING
            paint.pathEffect = DashPathEffect(floatArrayOf(s * 0.06f, s * 0.04f), 0f)
            c.drawCircle(cx, cx, s * 0.46f, paint)
            paint.pathEffect = null
            paint.style = Paint.Style.FILL
        }

        paint.color = INK
        paint.typeface = typeface(context)
        paint.textSize = s * 0.42f
        paint.textAlign = Paint.Align.CENTER
        val fm = paint.fontMetrics
        c.drawText(letter(name), cx, cx - (fm.ascent + fm.descent) / 2f, paint)

        teamIcon(symbol)?.let { res ->
            val d = ContextCompat.getDrawable(context, res)?.mutate() ?: return@let
            // Bottom corner at 135 degrees, so the badge's far edge stays within radius 0.5.
            val br = s * 0.14f
            val off = s * 0.33f * 0.7071f
            val bx = cx - off
            val by = cx + off
            paint.color = BADGE
            c.drawCircle(bx, by, br, paint)
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = s * 0.012f
            paint.color = CIRCLE
            c.drawCircle(bx, by, br, paint)
            paint.style = Paint.Style.FILL
            val ir = (br * 0.68f).toInt()
            d.setBounds((bx - ir).toInt(), (by - ir).toInt(), (bx + ir).toInt(), (by + ir).toInt())
            DrawableCompat.setTint(d, INK)
            d.draw(c)
        }
        return bmp
    }
}
