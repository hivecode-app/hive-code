package app.hivecode.hq

import android.content.Context
import app.hivecode.notify.Wording
import okhttp3.Call
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.TimeUnit

/** A failed hq call, already phrased for the owner (one sentence, no codes). */
/** [code] is the HTTP status when hq answered, 0 when it never did. */
class HqError(val sentence: String, cause: Throwable? = null, val code: Int = 0) : Exception(sentence, cause)

/**
 * Blocking REST client for hq. Called from background threads only (receivers under goAsync, the
 * service's executor). The base URL is the Caddy prefix, e.g. https://app.hq.example.com/<secret>/hq.
 */
class HqClient(private val baseUrl: String, private val token: String) {

    fun inboxJson(): String = get("/api/inbox")
    fun asksJson(): String = get("/api/asks")
    fun boardJson(): String = get("/api/board")
    fun togglesJson(): String = get("/api/toggles")

    fun answerAsk(askId: String, answer: String) {
        post("/api/asks/${enc(askId)}/answer", JSONObject().put("answer", answer).put("by", "owner"))
    }

    fun inboxDone(itemId: Long, note: String? = null) {
        post("/api/inbox/$itemId/done", JSONObject().apply { if (note != null) put("note", note) })
    }

    fun inboxAck(itemId: Long) {
        post("/api/inbox/$itemId/ack", JSONObject())
    }

    /** [msgId] makes a retry after a timeout idempotent on the hq side; pass the same one again. */
    fun tell(to: String, body: String, priority: String = "next", msgId: String? = null) {
        post(
            "/api/messages/tell",
            JSONObject().put("to", to).put("body", body).put("priority", priority).put("from", "owner")
                .put("msg_id", msgId ?: "app-${UUID.randomUUID()}"),
        )
    }

    fun interrupt(shiftId: String) {
        post("/api/shifts/${enc(shiftId)}/interrupt", JSONObject())
    }

    fun setToggle(key: String, enabled: Boolean): String =
        send("PUT", "/api/toggles/${enc(key)}", JSONObject().put("enabled", enabled))

    /** The live shift of a worker, read fresh so "עצירה" never interrupts a shift that already ended. */
    fun liveShiftId(identityId: String): String? =
        HqJson.board(boardJson())[identityId]?.takeIf { it.shiftLive }?.shiftId

    /** A raw GET for a big body (the update APK, update/AppUpdater.kt); null when the base URL is unusable. */
    fun download(path: String): Call? {
        val url = (baseUrl + path).toHttpUrlOrNull() ?: return null
        return downloads.newCall(Request.Builder().url(url).header("Authorization", "Bearer $token").build())
    }

    /** Null when the stored base URL is unusable (validated in [isValidBaseUrl] on configure). */
    fun wsRequest(afterSeq: Long): Request? {
        val q = if (afterSeq >= 0) "?after=$afterSeq" else ""
        val url = "$baseUrl/ws$q".toHttpUrlOrNull() ?: return null
        return Request.Builder().url(url).header("Authorization", "Bearer $token").build()
    }

    private fun get(path: String): String = send("GET", path, null)

    private fun post(path: String, body: JSONObject): String = send("POST", path, body)

    private fun send(method: String, path: String, body: JSONObject?): String {
        try {
            val url = (baseUrl + path).toHttpUrlOrNull() ?: throw HqError(Wording.ERR_NOT_CONFIGURED)
            val req = Request.Builder()
                .url(url)
                .header("Authorization", "Bearer $token")
                .method(method, body?.toString()?.toRequestBody(JSON))
                .build()
            http.newCall(req).execute().use { res ->
                val text = res.body?.string().orEmpty()
                if (res.isSuccessful) return text
                throw HqError(
                    when (res.code) {
                        401, 403 -> Wording.ERR_AUTH
                        404, 409 -> Wording.ERR_GONE
                        else -> Wording.ERR_SERVER
                    },
                    code = res.code,
                )
            }
        } catch (e: HqError) {
            throw e
        } catch (e: java.net.UnknownHostException) {
            throw HqError(Wording.ERR_OFFLINE, e)
        } catch (e: java.net.ConnectException) {
            throw HqError(Wording.ERR_OFFLINE, e)
        } catch (e: IOException) {
            throw HqError(Wording.ERR_SERVER, e)
        } catch (e: IllegalArgumentException) {
            throw HqError(Wording.ERR_NOT_CONFIGURED, e)
        }
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()

        /**
         * One shared client. callTimeout keeps a one-tap send (3 s countdown + request + result)
         * well inside the broadcast receiver's goAsync window.
         */
        val http: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .callTimeout(8, TimeUnit.SECONDS)
            .build()

        /**
         * The WebSocket needs no call timeout. Pings detect a dead link behind NAT or Caddy; 90 s
         * keeps the radio mostly asleep (each ping wakes it) while still noticing a dead socket.
         */
        val ws: OkHttpClient = http.newBuilder()
            .callTimeout(0, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS)
            .pingInterval(90, TimeUnit.SECONDS)
            .build()

        /** A 20 MB APK on a phone network: no call timeout, but a stalled read still fails. */
        val downloads: OkHttpClient = http.newBuilder()
            .callTimeout(0, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()

        /** http(s) with a host. Checked on configure so a bad value never reaches the service. */
        fun isValidBaseUrl(url: String): Boolean {
            val u = url.trim().toHttpUrlOrNull() ?: return false
            return u.host.isNotBlank() && (u.scheme == "https" || u.scheme == "http")
        }

        fun from(context: Context): HqClient? {
            val p = Prefs(context)
            return HqClient(p.baseUrl ?: return null, p.token ?: return null)
        }
    }
}
