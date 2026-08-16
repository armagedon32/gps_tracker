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

class MainActivity : AppCompatActivity() {

    private lateinit var nameInput: EditText
    private lateinit var startBtn: Button
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
        statusText = findViewById(R.id.statusText)

        nameInput.setText(prefs.getString("device_name", ""))

        val running = LocationService.isRunning(this)
        updateUI(running)

        startBtn.setOnClickListener {
            if (!running) {
                prefs.edit().putString("device_name", nameInput.text.toString().trim()).apply()
                checkPermissionsAndStart()
            } else {
                stopService(Intent(this, LocationService::class.java))
                updateUI(false)
            }
        }

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