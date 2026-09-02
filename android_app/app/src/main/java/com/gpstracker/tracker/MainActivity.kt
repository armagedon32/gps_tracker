package com.gpstracker.tracker

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : AppCompatActivity() {

    private lateinit var nameInput: EditText
    private lateinit var startBtn: Button
    private lateinit var sosBtn: Button
    private lateinit var statusText: TextView
    private val prefs: SharedPreferences by lazy {
        getSharedPreferences("gps_tracker", Context.MODE_PRIVATE)
    }

    private val locationPerms = arrayOf(
        Manifest.permission.ACCESS_FINE_LOCATION,
        Manifest.permission.ACCESS_COARSE_LOCATION
    )

    private val reqPerms = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        val granted = result.values.all { it }
        if (granted) {
            maybeRequestBackground()
        } else {
            Toast.makeText(this, "Kailangan ang location permission.", Toast.LENGTH_LONG).show()
        }
    }

    private val reqBg = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            startServiceSafe()
        } else {
            Toast.makeText(this, "Kailangan ang background location para gumana kahit sarado ang app.", Toast.LENGTH_LONG).show()
            startServiceSafe()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        nameInput = findViewById(R.id.nameInput)
        startBtn = findViewById(R.id.startBtn)
        sosBtn = findViewById(R.id.sosBtn)
        statusText = findViewById(R.id.statusText)

        nameInput.setText(prefs.getString("device_name", ""))

        val running = LocationService.isRunning(this)
        updateUI(running)

        startBtn.setOnClickListener {
            if (!running) {
                prefs.edit().putString("device_name", nameInput.text.toString().trim()).apply()
                checkPermissionsAndStart()
            } else {
                // User-initiated stop: disable boot auto-restart
                prefs.edit().putBoolean("tracking_enabled", false).apply()
                stopService(Intent(this, LocationService::class.java))
                updateUI(false)
            }
        }

        sosBtn.setOnClickListener { sendSos() }

        requestBatteryOptimizationIfNeeded()
    }

    override fun onResume() {
        super.onResume()
        updateUI(LocationService.isRunning(this))
    }

    private fun checkPermissionsAndStart() {
        val notGranted = locationPerms.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (notGranted.isEmpty()) {
            maybeRequestBackground()
        } else {
            reqPerms.launch(locationPerms)
        }
    }

    private fun maybeRequestBackground() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val hasBg = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED
            if (!hasBg) {
                reqBg.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                return
            }
        }
        startServiceSafe()
    }

    private fun startServiceSafe() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(Intent(this, LocationService::class.java))
        } else {
            startService(Intent(this, LocationService::class.java))
        }
        Toast.makeText(this, "Nagsisimula na ang pag-track...", Toast.LENGTH_SHORT).show()
        updateUI(true)
    }

    private fun updateUI(running: Boolean) {
        if (running) {
            startBtn.text = "I-STOP ang pag-track"
            statusText.text = "● Nagta-track ang app (background). Huwag isara ang notification."
        } else {
            startBtn.text = "SIMULAN ang pag-track"
            statusText.text = "Hindi nagta-track."
        }
    }

    private fun sendSos() {
        val latStr = prefs.getString("last_lat", null)
        val lngStr = prefs.getString("last_lng", null)
        if (latStr == null || lngStr == null) {
            Toast.makeText(this, "Walang GPS fix pa. Pindutin muna ang SIMULAN ang pag-track.", Toast.LENGTH_LONG).show()
            return
        }
        val deviceId = prefs.getString("device_id", "UNKNOWN") ?: "UNKNOWN"
        val name = prefs.getString("device_name", "") ?: ""
        Toast.makeText(this, "Ipinapadala ang SOS...", Toast.LENGTH_SHORT).show()
        Thread {
            var ok = false
            try {
                val conn = URL("${BuildConfig.API_BASE}/api/sos").openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.connectTimeout = 10000
                conn.readTimeout = 10000
                conn.setRequestProperty("Content-Type", "application/json")
                val body = JSONObject()
                body.put("device_id", deviceId)
                body.put("name", name)
                body.put("lat", latStr.toDouble())
                body.put("lng", lngStr.toDouble())
                conn.outputStream.use { os ->
                    val writer = OutputStreamWriter(os, Charsets.UTF_8)
                    writer.write(body.toString())
                    writer.flush()
                }
                ok = conn.responseCode in 200..299
                conn.disconnect()
            } catch (e: Exception) {
                // ignore
            }
            runOnUiThread {
                if (ok) {
                    Toast.makeText(this, "🆘 SOS NAIPADALA! Nakikita na sa dashboard.", Toast.LENGTH_LONG).show()
                } else {
                    Toast.makeText(this, "Hindi ma-send ang SOS — check ang internet.", Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }

    private fun requestBatteryOptimizationIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                try {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    intent.data = Uri.parse("package:$packageName")
                    startActivity(intent)
                } catch (e: Exception) {
                    // ignore
                }
            }
        }
    }
}