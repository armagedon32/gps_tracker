package com.gpstracker.tracker

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.NotificationManager.IMPORTANCE_LOW
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.OutputStream
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

class LocationService : Service() {

    companion object {
        const val CHANNEL_ID = "gps_tracker_channel"
        const val NOTIF_ID = 1
        private const val SEND_INTERVAL_MS = 10000L // 10 seconds
        private var running = false

        fun isRunning(context: Context): Boolean = running
    }

    private lateinit var locationManager: LocationManager
    private val handler = Handler(Looper.getMainLooper())
    private val prefs by lazy { getSharedPreferences("gps_tracker", Context.MODE_PRIVATE) }

    private var bestLat = 0.0
    private var bestLng = 0.0
    private var bestAcc = Float.MAX_VALUE
    private var hasFix = false

    private val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            val acc = location.accuracy
            // Tanggapin lang ang mahusay na fix; i-send kapag mas mahusay kaysa sa kasalukuyan
            if (!hasFix || acc <= bestAcc) {
                bestLat = location.latitude
                bestLng = location.longitude
                bestAcc = acc
                hasFix = true
                sendLocation(location, prefs.getString("device_name", "") ?: "")
            }
        }

        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    override fun onCreate() {
        super.onCreate()
        running = true
        // Mark tracking as enabled so BootReceiver can restart the service
        prefs.edit().putBoolean("tracking_enabled", true).apply()
        createChannel()
        locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val deviceId = prefs.getString("device_id", null)
            ?: UUID.randomUUID().toString().substring(0, 8).uppercase()
        prefs.edit().putString("device_id", deviceId).apply()
        startForeground(NOTIF_ID, buildNotification())
        startLocationUpdates()
        handler.post(sendRunnable)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIF_ID, buildNotification())
        return START_STICKY
    }

    private fun createChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "GPS Tracker",
            IMPORTANCE_LOW
        )
        channel.setShowBadge(false)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("GPS Tracker")
            .setContentText("Nagta-track sa background")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentIntent(pi)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }

    private fun startLocationUpdates() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        try {
// GPS muna; ang network ay backup lang kung walang GPS lock
        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        var started = false
        for (p in providers) {
            if (locationManager.isProviderEnabled(p)) {
                val minTime = if (p == LocationManager.GPS_PROVIDER) 2000L else 10000L
                locationManager.requestLocationUpdates(p, minTime, 0f, listener, Looper.getMainLooper())
                started = true
            }
        }
        if (!started) {
            // walang provider; use last known (best accuracy)
            val last = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                ?: locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
            if (last != null && (!hasFix || last.accuracy <= bestAcc)) {
                bestLat = last.latitude
                bestLng = last.longitude
                bestAcc = last.accuracy
                hasFix = true
                sendLocation(last, prefs.getString("device_name", "") ?: "")
            }
        }
        } catch (e: Exception) {
            // ignore
        }
    }

    private val sendRunnable = object : Runnable {
        override fun run() {
            // i-send ang pinakamahusay na fix kahit walang bagong update
            sendBestLocation()
            handler.postDelayed(this, SEND_INTERVAL_MS)
        }
    }

    private fun sendBestLocation() {
        if (!hasFix) return
        val loc = Location(LocationManager.GPS_PROVIDER)
        loc.latitude = bestLat
        loc.longitude = bestLng
        loc.accuracy = bestAcc
        sendLocation(loc, prefs.getString("device_name", "") ?: "")
    }

    private fun sendLocation(location: Location, name: String) {
        // Save the last fix so MainActivity can send an SOS with it
        prefs.edit()
            .putString("last_lat", location.latitude.toString())
            .putString("last_lng", location.longitude.toString())
            .putString("last_acc", location.accuracy.toString())
            .putLong("last_fix_ts", System.currentTimeMillis())
            .apply()
        Thread {
            try {
                val deviceId = prefs.getString("device_id", "UNKNOWN") ?: "UNKNOWN"
                val urlObj = URL("${BuildConfig.API_BASE}/api/location")
                val conn = urlObj.openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.connectTimeout = 10000
                conn.readTimeout = 10000
                conn.setRequestProperty("Content-Type", "application/json")

                val body = JSONObject()
                body.put("device_id", deviceId)
                body.put("name", name)
                body.put("lat", location.latitude)
                body.put("lng", location.longitude)
                body.put("accuracy", location.accuracy)
                body.put("speed", if (location.hasSpeed()) location.speed else 0.0)

                conn.outputStream.use { os ->
                    val writer = OutputStreamWriter(os, Charsets.UTF_8)
                    writer.write(body.toString())
                    writer.flush()
                }
                conn.inputStream.close()
                conn.disconnect()
            } catch (e: Exception) {
                // ignore; retry next cycle
            }
        }.start()
    }

    override fun onDestroy() {
        running = false
        handler.removeCallbacksAndMessages(null)
        try {
            locationManager.removeUpdates(listener)
        } catch (e: Exception) {
        }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}