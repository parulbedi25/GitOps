package com.trailpin.tracker

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.format.DateUtils
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.widget.doAfterTextChanged
import com.google.android.material.button.MaterialButton
import com.google.android.material.button.MaterialButtonToggleGroup
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.textfield.TextInputEditText

/**
 * The whole settings screen: one form, one status line, one live log.
 *
 * There is no map and no account. The point of the screen is to let someone
 * type `https://example.com` plus a token, press Start, and then watch the exact
 * request that leaves the phone.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var configStore: ConfigStore
    private var stored: TrackerConfig = TrackerConfig()
    private val handler = Handler(Looper.getMainLooper())

    private lateinit var urlInput: TextInputEditText
    private lateinit var pathInput: TextInputEditText
    private lateinit var tokenInput: TextInputEditText
    private lateinit var tokenParamInput: TextInputEditText
    private lateinit var deviceInput: TextInputEditText
    private lateinit var intervalInput: TextInputEditText
    private lateinit var distanceInput: TextInputEditText
    private lateinit var protocolGroup: MaterialButtonToggleGroup
    private lateinit var methodSpinner: Spinner
    private lateinit var heartbeatSwitch: MaterialSwitch
    private lateinit var bootSwitch: MaterialSwitch
    private lateinit var statusText: TextView
    private lateinit var previewText: TextView
    private lateinit var logText: TextView
    private lateinit var startStopButton: MaterialButton

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            if (hasLocationPermission()) {
                beginTracking()
            } else {
                toast(getString(R.string.error_permission_required))
            }
        }

    private val backgroundPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            toast(
                getString(
                    if (granted) R.string.toast_background_granted else R.string.toast_background_hint,
                ),
            )
            refreshUi()
        }

    private val refreshTask = object : Runnable {
        override fun run() {
            refreshUi()
            handler.postDelayed(this, REFRESH_INTERVAL_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        configStore = ConfigStore(this)
        stored = configStore.load()

        bindViews()
        setUpMethodSpinner()
        setUpListeners()
        loadIntoForm(stored)
        refreshUi()
    }

    override fun onResume() {
        super.onResume()
        refreshUi()
        handler.postDelayed(refreshTask, REFRESH_INTERVAL_MS)
    }

    override fun onPause() {
        handler.removeCallbacks(refreshTask)
        super.onPause()
    }

    // ── setup ────────────────────────────────────────────────────────────────

    private fun bindViews() {
        urlInput = findViewById(R.id.inputUrl)
        pathInput = findViewById(R.id.inputPath)
        tokenInput = findViewById(R.id.inputToken)
        tokenParamInput = findViewById(R.id.inputTokenParam)
        deviceInput = findViewById(R.id.inputDevice)
        intervalInput = findViewById(R.id.inputInterval)
        distanceInput = findViewById(R.id.inputDistance)
        protocolGroup = findViewById(R.id.protocolGroup)
        methodSpinner = findViewById(R.id.spinnerMethod)
        heartbeatSwitch = findViewById(R.id.switchHeartbeat)
        bootSwitch = findViewById(R.id.switchBoot)
        statusText = findViewById(R.id.textStatus)
        previewText = findViewById(R.id.textPreview)
        logText = findViewById(R.id.textLog)
        startStopButton = findViewById(R.id.buttonStartStop)
    }

    private fun setUpMethodSpinner() {
        val labels = HttpMethod.values().map { it.label }
        val adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, labels)
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        methodSpinner.adapter = adapter
        methodSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                updatePreview()
            }

            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
        }
    }

    private fun setUpListeners() {
        for (input in listOf(urlInput, pathInput, tokenInput, tokenParamInput, deviceInput)) {
            input.doAfterTextChanged { updatePreview() }
        }
        intervalInput.doAfterTextChanged { updatePreview() }
        distanceInput.doAfterTextChanged { updatePreview() }

        protocolGroup.addOnButtonCheckedListener { _, _, isChecked ->
            if (isChecked) updatePreview()
        }

        startStopButton.setOnClickListener {
            if (configStore.trackingEnabled) stopTracking() else requestPermissionsAndStart()
        }
        findViewById<MaterialButton>(R.id.buttonSave).setOnClickListener { saveForm(showToast = true) }
        findViewById<MaterialButton>(R.id.buttonSendNow).setOnClickListener { sendTestReport() }
        findViewById<MaterialButton>(R.id.buttonClearLog).setOnClickListener {
            LogStore.clear(this)
            refreshLog()
            toast(getString(R.string.toast_log_cleared))
        }
        findViewById<MaterialButton>(R.id.buttonBackground).setOnClickListener {
            requestBackgroundLocation()
        }
        findViewById<MaterialButton>(R.id.buttonBattery).setOnClickListener {
            requestIgnoreBatteryOptimizations()
        }
    }

    private fun loadIntoForm(config: TrackerConfig) {
        urlInput.setText(config.serverUrl)
        pathInput.setText(config.apiPath)
        tokenInput.setText(config.token)
        tokenParamInput.setText(config.tokenParam)
        deviceInput.setText(config.deviceId)
        intervalInput.setText(config.intervalSeconds.toString())
        distanceInput.setText(config.distanceMeters.toString())
        heartbeatSwitch.isChecked = config.heartbeat
        bootSwitch.isChecked = config.startOnBoot
        when (config.protocol) {
            Protocol.HTTP -> protocolGroup.check(R.id.buttonProtocolHttp)
            Protocol.HTTPS -> protocolGroup.check(R.id.buttonProtocolHttps)
            Protocol.AUTO -> protocolGroup.check(R.id.buttonProtocolAuto)
        }
        methodSpinner.setSelection(config.method.ordinal)
    }

    // ── form ↔ config ────────────────────────────────────────────────────────

    private fun readForm(): TrackerConfig = TrackerConfig(
        serverUrl = urlInput.text?.toString().orEmpty().trim(),
        apiPath = pathInput.text?.toString().orEmpty().trim(),
        token = tokenInput.text?.toString().orEmpty().trim(),
        tokenParam = tokenParamInput.text?.toString().orEmpty().trim(),
        method = HttpMethod.values()[
            methodSpinner.selectedItemPosition.coerceIn(0, HttpMethod.values().size - 1),
        ],
        protocol = selectedProtocol(),
        deviceId = deviceInput.text?.toString().orEmpty().trim().ifEmpty { stored.deviceId },
        intervalSeconds = intervalInput.text?.toString().orEmpty().toIntOrNull()
            ?: ConfigStore.DEFAULT_INTERVAL_SECONDS,
        distanceMeters = distanceInput.text?.toString().orEmpty().toIntOrNull()
            ?: ConfigStore.DEFAULT_DISTANCE_METERS,
        heartbeat = heartbeatSwitch.isChecked,
        startOnBoot = bootSwitch.isChecked,
    )

    private fun selectedProtocol(): Protocol = when (protocolGroup.checkedButtonId) {
        R.id.buttonProtocolHttp -> Protocol.HTTP
        R.id.buttonProtocolHttps -> Protocol.HTTPS
        else -> Protocol.AUTO
    }

    private fun validate(config: TrackerConfig): Int? = when {
        config.serverUrl.isBlank() -> R.string.error_url_required
        UrlFactory.normalizeBase(config.serverUrl, config.protocol) == null -> R.string.error_url_invalid
        config.token.isBlank() -> R.string.error_token_required
        else -> null
    }

    private fun saveForm(showToast: Boolean): TrackerConfig? {
        val config = readForm()
        val error = validate(config)
        if (error != null) {
            toast(getString(error))
            return null
        }
        configStore.save(config)
        stored = configStore.load()
        if (showToast) {
            toast(getString(R.string.toast_saved))
        }
        refreshUi()
        return stored
    }

    // ── tracking ─────────────────────────────────────────────────────────────

    private fun requestPermissionsAndStart() {
        if (saveForm(showToast = false) == null) return
        if (!hasLocationPermission()) {
            permissionLauncher.launch(requiredPermissions())
            return
        }
        beginTracking()
    }

    private fun beginTracking() {
        val config = saveForm(showToast = false) ?: return
        configStore.trackingEnabled = true
        TrackerService.start(this)
        LogStore.append(this, "tracking requested → " + UrlFactory.endpointUrl(config, samplePosition()))
        refreshUi()
    }

    private fun stopTracking() {
        TrackerService.stop(this)
        configStore.trackingEnabled = false
        LogStore.append(this, "stop requested")
        refreshUi()
    }

    private fun sendTestReport() {
        val config = saveForm(showToast = false) ?: return
        if (!hasLocationPermission()) {
            toast(getString(R.string.error_permission_required))
            return
        }
        val location = bestLastKnownLocation()
        if (location == null) {
            toast(getString(R.string.error_no_fix))
            return
        }
        val position = positionFrom(location)
        val url = UrlFactory.endpointUrl(config, position)
        LogStore.append(this, "test report → $url")
        refreshLog()
        toast(getString(R.string.toast_sending))

        Thread {
            val result = ReportSender.send(config, position)
            val prefix = if (result.success) "test report ok — " else "test report failed — "
            LogStore.append(this, prefix + result.message)
            runOnUiThread {
                refreshUi()
                toast(
                    getString(
                        if (result.success) R.string.toast_test_sent else R.string.toast_test_failed,
                    ),
                )
            }
        }.start()
    }

    // ── permissions & system settings ────────────────────────────────────────

    private fun hasLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    private fun hasBackgroundLocation(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.ACCESS_BACKGROUND_LOCATION,
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }

    private fun requiredPermissions(): Array<String> {
        val permissions = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        return permissions.toTypedArray()
    }

    private fun requestBackgroundLocation() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            toast(getString(R.string.toast_background_not_needed))
            return
        }
        if (hasBackgroundLocation()) {
            toast(getString(R.string.toast_background_granted))
            return
        }
        if (!hasLocationPermission()) {
            permissionLauncher.launch(requiredPermissions())
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Android 11+ only grants "Allow all the time" from the settings page.
            openAppSettings()
        } else {
            backgroundPermissionLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        }
    }

    private fun requestIgnoreBatteryOptimizations() {
        val powerManager = getSystemService(Context.POWER_SERVICE) as? PowerManager
        if (powerManager?.isIgnoringBatteryOptimizations(packageName) == true) {
            toast(getString(R.string.toast_battery_already))
            return
        }
        val request = Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:$packageName"),
        )
        runCatching { startActivity(request) }.onFailure {
            runCatching { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
                .onFailure { toast(getString(R.string.toast_open_settings_failed)) }
        }
    }

    private fun openAppSettings() {
        val intent = Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", packageName, null),
        )
        runCatching { startActivity(intent) }
            .onFailure { toast(getString(R.string.toast_open_settings_failed)) }
    }

    // ── ui ───────────────────────────────────────────────────────────────────

    private fun refreshUi() {
        val tracking = configStore.trackingEnabled
        startStopButton.setText(if (tracking) R.string.button_stop else R.string.button_start)

        val lastLine = if (configStore.lastAtMs() == 0L) {
            getString(R.string.last_result_none)
        } else {
            getString(
                R.string.last_result_format,
                getString(
                    if (configStore.lastSucceeded()) R.string.last_result_ok else R.string.last_result_failed,
                ),
                DateUtils.getRelativeTimeSpanString(
                    configStore.lastAtMs(),
                    System.currentTimeMillis(),
                    DateUtils.MINUTE_IN_MILLIS,
                ).toString(),
                configStore.lastSummary(),
            )
        }

        statusText.text = buildString {
            append(getString(if (tracking) R.string.tracking_on else R.string.tracking_off))
            append('\n')
            append(getString(R.string.status_device_format, stored.deviceId))
            append('\n')
            append(getString(R.string.status_endpoint_format, endpointLabel()))
            append('\n')
            append(lastLine)
            if (!hasBackgroundLocation()) {
                append('\n')
                append(getString(R.string.status_background_hint))
            }
        }

        updatePreview()
        refreshLog()
    }

    private fun endpointLabel(): String {
        val base = UrlFactory.normalizeBase(stored.serverUrl, stored.protocol)
        return base ?: getString(R.string.status_endpoint_missing)
    }

    private fun updatePreview() {
        if (::configStore.isInitialized) {
            val url = UrlFactory.endpointUrl(readForm(), samplePosition())
            previewText.text = url ?: getString(R.string.preview_placeholder)
        }
    }

    private fun refreshLog() {
        val text = LogStore.read(this)
        logText.text = if (text.isBlank()) getString(R.string.log_empty) else text
    }

    private fun samplePosition(): Position = Position(
        latitude = 31.326,
        longitude = 75.576,
        timestampMs = System.currentTimeMillis(),
        accuracy = 8f,
        battery = 87,
        provider = "gps",
    )

    private fun positionFrom(location: Location): Position = Position(
        latitude = location.latitude,
        longitude = location.longitude,
        timestampMs = System.currentTimeMillis(),
        accuracy = if (location.hasAccuracy()) location.accuracy else null,
        altitude = if (location.hasAltitude()) location.altitude else null,
        speed = if (location.hasSpeed()) location.speed else null,
        bearing = if (location.hasBearing()) location.bearing else null,
        battery = DeviceStatus.batteryPercent(this),
        provider = location.provider,
    )

    @SuppressLint("MissingPermission")
    private fun bestLastKnownLocation(): Location? {
        if (!hasLocationPermission()) return null
        val manager = getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
        val providers = listOf(
            LocationManager.GPS_PROVIDER,
            LocationManager.NETWORK_PROVIDER,
            LocationManager.PASSIVE_PROVIDER,
        )
        return providers
            .mapNotNull { provider ->
                runCatching { manager.getLastKnownLocation(provider) }.getOrNull()
            }
            .maxByOrNull { it.time }
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    private companion object {
        const val REFRESH_INTERVAL_MS = 2_000L
    }
}
