package app.hivecode

import app.hivecode.update.ApkStream
import app.hivecode.update.UpdateCancelled
import app.hivecode.update.UpdateFailure
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.security.MessageDigest

class ApkStreamTest {
    private val apk = ByteArray(1_000_000) { (it % 251).toByte() }
    private val sum = MessageDigest.getInstance("SHA-256").digest(apk).joinToString("") { "%02x".format(it) }

    @Test fun copiesAndReportsProgressOncePerPercent() {
        val out = ByteArrayOutputStream()
        val seen = mutableListOf<Long>()
        ApkStream.copyVerified(ByteArrayInputStream(apk), out, apk.size.toLong(), sum, { false }) { seen += it }
        assertArrayEquals(apk, out.toByteArray())
        assertEquals(apk.size.toLong(), seen.last())
        assertTrue("at most one event per percent", seen.size <= 101)
        assertEquals(seen.sorted(), seen)
    }

    @Test fun refusesAWrongHash() {
        val e = assertThrows(UpdateFailure::class.java) {
            ApkStream.copyVerified(ByteArrayInputStream(apk), ByteArrayOutputStream(), apk.size.toLong(), "0".repeat(64), { false }) {}
        }
        assertEquals("integrity", e.reason)
    }

    @Test fun refusesAShortOrLongBody() {
        val short = apk.copyOf(apk.size - 1)
        assertEquals("integrity", assertThrows(UpdateFailure::class.java) {
            ApkStream.copyVerified(ByteArrayInputStream(short), ByteArrayOutputStream(), apk.size.toLong(), sum, { false }) {}
        }.reason)
        val long = apk + byteArrayOf(1)
        assertEquals("integrity", assertThrows(UpdateFailure::class.java) {
            ApkStream.copyVerified(ByteArrayInputStream(long), ByteArrayOutputStream(), apk.size.toLong(), sum, { false }) {}
        }.reason)
    }

    @Test fun stopsOnCancel() {
        var reads = 0
        assertThrows(UpdateCancelled::class.java) {
            ApkStream.copyVerified(ByteArrayInputStream(apk), ByteArrayOutputStream(), apk.size.toLong(), sum, { reads > 2 }) { reads++ }
        }
    }
}
