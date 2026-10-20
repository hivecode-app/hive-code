package app.hivecode

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import androidx.core.view.ContentInfoCompat
import androidx.core.view.OnReceiveContentListener
import androidx.core.view.ViewCompat
import androidx.core.view.inputmethod.EditorInfoCompat
import androidx.core.view.inputmethod.InputConnectionCompat
import io.flutter.FlutterInjector
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.StandardMessageCodec
import io.flutter.plugin.platform.PlatformView
import io.flutter.plugin.platform.PlatformViewFactory
import kotlin.concurrent.thread
import kotlin.math.roundToInt

/**
 * The composer's text field on Android (lib/ui/chat/composer_field.dart): Android's own EditText,
 * because Flutter's TextField gives the whole text one direction. Here every line takes its own
 * from its first strong letter, like WhatsApp: an English or code line is LTR and left-aligned, a
 * Hebrew line RTL. Selection handles, the copy/paste menu, select all and the keyboard's clipboard
 * are Android's. Images (a keyboard GIF/sticker, a copied screenshot pasted) go to Dart, which
 * shows them above the field; everything else is pasted as text.
 *
 * Channel `company/composer/<id>`:
 *   to Dart:   changed {text, start, end, seq} · height {px} (logical) · image {bytes, mime, name}
 *   from Dart: setValue {text, start, end, seq} · style {...} · focus
 */
class ComposerFieldFactory(private val messenger: BinaryMessenger) : PlatformViewFactory(StandardMessageCodec.INSTANCE) {
    override fun create(context: Context, viewId: Int, args: Any?): PlatformView =
        ComposerField(context, MethodChannel(messenger, "company/composer/$viewId"), args as? Map<*, *> ?: emptyMap<Any, Any>())
}

class ComposerField(private val context: Context, private val channel: MethodChannel, args: Map<*, *>) : PlatformView, MethodChannel.MethodCallHandler {
    private val main = Handler(Looper.getMainLooper())
    private val density = context.resources.displayMetrics.density
    private val edit = ComposerEditText(context)

    /** True while Dart's value is applied, so it is not sent straight back. */
    private var applying = false
    private var sent: Triple<String, Int, Int>? = null

    /** The number of the last value Dart set, sent back with every change (see composer_field.dart). */
    private var seq = 0
    private var sentHeight = -1
    private val report = Runnable { reportHeight() }

    init {
        edit.apply {
            background = null
            gravity = Gravity.TOP or Gravity.START
            // Per line (paragraph): the first strong letter decides; a line with none follows the app (RTL).
            layoutDirection = View.LAYOUT_DIRECTION_RTL
            textDirection = View.TEXT_DIRECTION_FIRST_STRONG_RTL
            textAlignment = View.TEXT_ALIGNMENT_GRAVITY
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
            imeOptions = EditorInfo.IME_FLAG_NO_FULLSCREEN
            minLines = 1
            maxLines = MAX_LINES
            isVerticalScrollBarEnabled = true
            overScrollMode = View.OVER_SCROLL_NEVER
            includeFontPadding = false
            heebo(context)?.let { typeface = it }
        }
        applyStyle(args)
        (args["text"] as? String)?.let { setValue(it, args["start"] as? Int ?: it.length, args["end"] as? Int ?: it.length) }
        ViewCompat.setOnReceiveContentListener(edit, IMAGE_MIMES, OnReceiveContentListener { _, payload -> receive(payload) })
        edit.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                sendValue()
                scheduleHeight()
            }
        })
        edit.onSelection = { sendValue() }
        edit.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> scheduleHeight() }
        channel.setMethodCallHandler(this)
    }

    override fun getView(): View = edit

    override fun dispose() {
        main.removeCallbacks(report)
        channel.setMethodCallHandler(null)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "setValue" -> {
                val text = call.argument<String>("text").orEmpty()
                seq = call.argument<Int>("seq") ?: seq
                setValue(text, call.argument<Int>("start") ?: text.length, call.argument<Int>("end") ?: text.length)
                result.success(null)
            }
            "style" -> {
                applyStyle(call.arguments as? Map<*, *> ?: emptyMap<Any, Any>())
                result.success(null)
            }
            "focus" -> {
                edit.requestFocus()
                context.getSystemService(InputMethodManager::class.java)?.showSoftInput(edit, InputMethodManager.SHOW_IMPLICIT)
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    private fun setValue(text: String, start: Int, end: Int) {
        applying = true
        try {
            if (edit.text.toString() != text) edit.setText(text)
            val len = edit.length()
            edit.setSelection(start.coerceIn(0, len), end.coerceIn(0, len))
            sent = Triple(text, edit.selectionStart, edit.selectionEnd)
        } finally {
            applying = false
        }
        scheduleHeight()
    }

    private fun sendValue() {
        if (applying) return
        val v = Triple(edit.text.toString(), edit.selectionStart, edit.selectionEnd)
        if (v == sent) return
        sent = v
        channel.invokeMethod("changed", mapOf("text" to v.first, "start" to v.second, "end" to v.third, "seq" to seq))
    }

    private fun scheduleHeight() {
        main.removeCallbacks(report)
        main.post(report)
    }

    /** The field grows with its lines up to [MAX_LINES], then scrolls inside itself. */
    private fun reportHeight() {
        val layout = edit.layout ?: return
        val lines = layout.lineCount.coerceIn(1, MAX_LINES)
        val px = layout.getLineTop(lines) + edit.compoundPaddingTop + edit.compoundPaddingBottom
        if (px == sentHeight) return
        sentHeight = px
        channel.invokeMethod("height", mapOf("px" to px / density))
    }

    /** {hint, color, hintColor, accent (ARGB ints), size (sp), height (line height ÷ size), padding [l, t, r, b] (dp)}. */
    private fun applyStyle(s: Map<*, *>) {
        (s["hint"] as? String)?.let { edit.hint = it }
        (s["color"] as? Number)?.let { edit.setTextColor(it.toInt()) }
        (s["hintColor"] as? Number)?.let { edit.setHintTextColor(it.toInt()) }
        (s["size"] as? Number)?.let { edit.setTextSize(TypedValue.COMPLEX_UNIT_SP, it.toFloat()) }
        (s["height"] as? Number)?.let { edit.setLineSpacing(edit.textSize * it.toFloat() - edit.paint.fontSpacing, 1f) }
        (s["padding"] as? List<*>)?.map { ((it as? Number)?.toFloat() ?: 0f) * density }?.let {
            if (it.size == 4) edit.setPaddingRelative(it[0].roundToInt(), it[1].roundToInt(), it[2].roundToInt(), it[3].roundToInt())
        }
        (s["accent"] as? Number)?.toInt()?.let { accent ->
            edit.highlightColor = Color.argb(0x55, Color.red(accent), Color.green(accent), Color.blue(accent))
            if (Build.VERSION.SDK_INT >= 29) {
                edit.textCursorDrawable = GradientDrawable().apply {
                    setColor(accent)
                    setSize((2 * density).roundToInt(), edit.lineHeight)
                }
                listOf(edit.textSelectHandle, edit.textSelectHandleLeft, edit.textSelectHandleRight).forEach { it?.setTint(accent) }
            }
        }
        scheduleHeight()
    }

    /** Images go to Dart; text (and anything else) is left to the EditText. */
    private fun receive(payload: ContentInfoCompat): ContentInfoCompat? {
        val split = payload.partition { it.uri != null && it.text.isNullOrEmpty() }
        val images = split.first ?: return payload
        val uris = (0 until images.clip.itemCount).mapNotNull { images.clip.getItemAt(it).uri }
        thread(name = "company-composer-image") {
            for (uri in uris) {
                val image = readImage(uri)
                main.post { channel.invokeMethod("image", image ?: mapOf("error" to true)) }
            }
        }
        return split.second
    }

    private fun readImage(uri: Uri): Map<String, Any?>? {
        if (uri.scheme != "content" || uri.authority?.startsWith(context.packageName) != false) return null
        if (context.contentResolver.getType(uri)?.startsWith("image/") != true) return null
        return NativeBridge.readImage(context, uri)
    }

    companion object {
        const val MAX_LINES = 6
        private val IMAGE_MIMES = arrayOf("image/*")
        private var heebo: Typeface? = null

        /** The app's own font (pubspec: Heebo), from the Flutter assets. */
        private fun heebo(context: Context): Typeface? = heebo ?: try {
            val key = FlutterInjector.instance().flutterLoader().getLookupKeyForAsset("assets/fonts/Heebo-400.ttf")
            Typeface.createFromAsset(context.assets, key).also { heebo = it }
        } catch (_: Exception) {
            null
        }
    }
}

/**
 * EditText plus what AppCompatEditText adds before Android 12: keyboard images (commitContent) and
 * clipboard pastes reach the OnReceiveContentListener. From Android 12 the platform does both.
 */
class ComposerEditText(context: Context) : EditText(context) {
    var onSelection: (() -> Unit)? = null

    override fun onSelectionChanged(selStart: Int, selEnd: Int) {
        super.onSelectionChanged(selStart, selEnd)
        onSelection?.invoke()
    }

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val ic = super.onCreateInputConnection(outAttrs) ?: return null
        if (Build.VERSION.SDK_INT >= 31) return ic
        val mimes = ViewCompat.getOnReceiveContentMimeTypes(this) ?: return ic
        EditorInfoCompat.setContentMimeTypes(outAttrs, mimes)
        return InputConnectionCompat.createWrapper(this, ic, outAttrs)
    }

    override fun onTextContextMenuItem(id: Int): Boolean {
        // Only a clip with an image goes the listener's way; a text paste stays Android's own (the
        // compat fallback would drop the text: a plain EditText has no default receive behavior).
        if (Build.VERSION.SDK_INT < 31 && (id == android.R.id.paste || id == android.R.id.pasteAsPlainText)) {
            val clip = context.getSystemService(ClipboardManager::class.java)?.primaryClip ?: return super.onTextContextMenuItem(id)
            val image = (0 until clip.itemCount).any { clip.getItemAt(it).let { i -> i.uri != null && i.text.isNullOrEmpty() } }
            if (!image) return super.onTextContextMenuItem(id)
            val flags = if (id == android.R.id.pasteAsPlainText) ContentInfoCompat.FLAG_CONVERT_TO_PLAIN_TEXT else 0
            ViewCompat.performReceiveContent(this, ContentInfoCompat.Builder(clip, ContentInfoCompat.SOURCE_CLIPBOARD).setFlags(flags).build())
            return true
        }
        return super.onTextContextMenuItem(id)
    }
}
