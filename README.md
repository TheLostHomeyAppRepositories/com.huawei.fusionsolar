# Huawei FusionSolar Manager – Homey App

**App ID:** `com.huawei.fusionsolar`
**SDK:** Homey SDK 3
**Minimum firmware:** Homey >= 12.13.0
**Compatible with:** Homey Pro (Early 2019) and all newer Homey devices running firmware >= 12.13.0

> Firmware >= 12.13.0 is required by the OCPP Smart Charger's standard `target_power` capability. Earlier releases of this app targeted 12.4.5.

---

## Supported Connection Types

This app supports five independent connection methods to a Huawei FusionSolar installation:

| Connection      | Description                                                                        |
|-----------------|------------------------------------------------------------------------------------|
| **Kiosk**       | Reads plant data via the public Kiosk URL (no account required)                   |
| **OpenAPI**     | Connects via the official Northbound API using a FusionSolar account              |
| **Modbus TCP**  | Direct communication with SUN2000, LUNA2000 and DTSU666 over the local network   |
| **EMMA Modbus** | Direct communication via the EMMA Energy Management Module (SUN2000MA)            |
| **OCPP 1.6**    | Runs an OCPP 1.6 WebSocket server on Homey so EV chargers can connect directly    |

On top of these, the app includes an **Energy Management System (EMS)** device — a local orchestration layer that steers EV charging, heat pumps and other loads from live solar surplus. See [Energy Management System](#energy-management-system-ems).

---

## Devices

### FusionSolar Plant (Kiosk)

Connection via the public Kiosk URL. No FusionSolar account required.

| Capability       | Description                     |
|------------------|---------------------------------|
| Solar power      | Current generation power (W)    |
| Total yield      | Cumulative total yield (kWh)    |
| Daily yield      | Today's energy yield (kWh)      |
| Monthly yield    | Monthly energy yield (kWh)      |
| Yearly yield     | Annual energy yield (kWh)       |

---

### Inverter SUN2000 (OpenAPI)

Connection via the Huawei FusionSolar Northbound API. Provides inverter, grid and PV string data.

| Capability              | Description                                                        |
|-------------------------|--------------------------------------------------------------------|
| Solar power             | DC input power from PV strings (W)                                |
| Active power            | AC output power (W)                                               |
| Heat sink temperature   | Internal inverter temperature (°C)                                |
| Total yield             | Cumulative total yield (kWh)                                      |
| Daily yield             | Today's energy yield (kWh)                                        |
| PV1 / PV2 voltage       | DC voltage of PV strings (V)                                      |
| PV1 / PV2 current       | DC current of PV strings (A)                                      |
| Grid active power       | Current: positive = import, negative = export (W)                 |
| Total grid export       | Cumulative total energy exported to grid (kWh)                    |
| Total grid import       | Cumulative total energy imported from grid (kWh)                  |

> Grid values are sourced from the plant's Power Sensor (type 47) or Grid Meter (type 17).

---

### Battery LUNA2000 (OpenAPI)

Connection via the Huawei FusionSolar Northbound API.

| Capability               | Description                                          |
|--------------------------|------------------------------------------------------|
| Battery power            | Current: positive = charging, negative = discharging (W) |
| State of charge          | SoC in percent (%)                                   |
| Battery charge power     | Current charge power (W)                             |
| Battery discharge power  | Current discharge power (W)                          |
| Max charge power         | Configured maximum (W)                               |
| Max discharge power      | Configured maximum (W)                               |
| Daily charged energy     | Energy charged today (kWh)                           |
| Daily discharged energy  | Energy discharged today (kWh)                        |
| State of health          | SoH in percent (%)                                   |
| Battery status           | Operating state as text (e.g. Running, Standby)      |

---

### Power Meter (OpenAPI)

Connection via the Huawei FusionSolar Northbound API. Registered as a P1 meter (cumulative).

| Capability              | Description                                               |
|-------------------------|-----------------------------------------------------------|
| Grid active power       | Current: positive = import, negative = export (W)         |
| Total grid import       | Cumulative total energy imported (kWh)                    |
| Total grid export       | Cumulative total energy exported (kWh)                    |
| Phase A/B/C voltage     | Phase voltages (V) — dynamic                              |
| Phase A/B/C current     | Phase currents (A) — dynamic                              |
| Phase A/B/C power       | Phase power (W) — dynamic                                 |

---

### iSitePower-M Solar (OpenAPI)

Dedicated driver for the Huawei iSitePower-M Solar subsystem. Registered as a solar panel in the Homey Energy Dashboard.

| Capability    | Description                                      |
|---------------|--------------------------------------------------|
| Solar power   | Current PV output power (W)                      |
| Total yield   | Cumulative PV yield (kWh) — from station KPI     |

---

### iSitePower-M Battery (OpenAPI)

Dedicated driver for the Huawei iSitePower-M Battery subsystem. Registered as a home battery in the Homey Energy Dashboard.

| Capability               | Description                                              |
|--------------------------|----------------------------------------------------------|
| Battery power            | Current: positive = charging, negative = discharging (W) |
| State of charge          | SoC in percent (%)                                       |
| Charge power             | Current charge power (W)                                 |
| Discharge power          | Current discharge power (W)                              |
| Total charged energy     | Cumulative charged energy (kWh)                          |
| Total discharged energy  | Cumulative discharged energy (kWh)                       |
| Battery voltage          | Current battery voltage (V)                              |
| Remaining backup time    | Estimated backup runtime at current load (h)             |
| Total capacity           | Total installed battery capacity (kWh)                   |
| Discharge cycles         | Total number of discharge cycles                         |
| Battery state            | Human-readable state string — available in flows         |

---

### iSitePower-M Grid (OpenAPI)

Dedicated driver for the Huawei iSitePower-M Grid meter. Registered as a cumulative energy meter in the Homey Energy Dashboard. Grid power is read directly from the Mains meter (type 60001) when available, or derived from energy balance as fallback.

| Capability      | Description                                                  |
|-----------------|--------------------------------------------------------------|
| Grid power      | Current import power (W)                                     |
| Grid import     | Cumulative grid import (kWh)                                 |
| AC voltage      | Grid voltage (V)                                             |
| AC current      | Grid current (A)                                             |
| Grid frequency  | Grid frequency (Hz)                                          |

---

### iSitePower-M Home (OpenAPI)

Dedicated driver for the Huawei iSitePower-M Home consumption measurement. Registered as a cumulative energy consumer in the Homey Energy Dashboard.

| Capability         | Description                                              |
|--------------------|----------------------------------------------------------|
| Home consumption   | Current home load power (W)                              |
| Total consumption  | Cumulative home energy consumption (kWh)                 |

> If load data is temporarily unavailable from the API, the last known value is preserved (no drop to 0 W).

---

### SDongle A (Modbus)

Direct Modbus TCP connection to the Huawei SDongle A (unit ID 100).

| Capability              | Description                                                        |
|-------------------------|--------------------------------------------------------------------|
| House Consumption       | Current house load / consumption power (W)                         |
| Solar Input Power       | Total PV input power (W)                                           |
| Grid Power              | Current: positive = import, negative = export (W)                  |
| Battery Power           | Current: positive = charging, negative = discharging (W)           |
| Total Active Power      | Net system active power (W)                                        |
| Connection Type         | SDongle connection type (N/A, WLAN, 4G, WLAN-FE)                  |

---

### Inverter SUN2000 (Modbus)

Direct Modbus TCP connection to the SUN2000 inverter or SDongle.

| Capability                  | Description                                               |
|-----------------------------|-----------------------------------------------------------|
| Solar power                 | DC input power from PV strings (W)                        |
| Active power                | AC output power (W)                                       |
| Heat sink temperature       | Internal inverter temperature (°C)                        |
| Total yield                 | Cumulative total yield (kWh)                              |
| Daily yield                 | Today's energy yield (kWh)                                |
| PV1 / PV2 voltage           | DC voltage of PV strings (V)                              |
| PV1 / PV2 current           | DC current of PV strings (A)                              |
| Inverter status             | Operating state as text                                   |
| Active power control mode   | Configurable feed-in limit                                |
| Grid active power           | Current (W) — only when DTSU666 is connected              |
| Total grid import           | Cumulative (kWh) — only when DTSU666 is connected         |
| Total grid export           | Cumulative (kWh) — only when DTSU666 is connected         |

---

### Inverter SUN2000 (EMMA Modbus)

Reads inverter data via the EMMA Energy Management Module (unit ID 0). No SDongle or separate meter required.

| Capability              | Description                                               |
|-------------------------|-----------------------------------------------------------|
| Solar power             | PV output power (W)                                       |
| Active power            | Inverter active power (W)                                 |
| Total PV yield          | Cumulative total PV yield (kWh)                           |
| PV yield today          | PV energy yield today (kWh)                               |
| Total yield             | Inverter total yield (kWh)                                |
| Daily yield             | Inverter daily yield (kWh)                                |
| Grid active power       | Current: positive = import, negative = export (W)         |
| Total grid import       | Cumulative total energy imported (kWh)                    |
| Total grid export       | Cumulative total energy exported (kWh)                    |

---

### Battery LUNA2000 (Modbus)

Direct Modbus TCP connection to the LUNA2000 battery via SUN2000 / SDongle. If no LUNA2000 is detected on the RS485 bus, the device shows a targeted error distinguishing between "SUN2000 reachable but no LUNA2000 on RS485" (check the RS485 cable) and a general connection failure.

#### Readable Values

| Capability                  | Description                                              |
|-----------------------------|----------------------------------------------------------|
| Battery State Indicator     | Human-readable battery state: `850 W 🔺 67%` charging / `1200 W 🔻 45%` discharging / `(67%)` at idle / `Full (100%)` / `Empty (<5%)` — hidden in UI, available in flows |
| Battery power               | Current: positive = charging, negative = discharging (W) |
| State of charge             | SoC in percent (%)                                       |
| Total charged energy        | Cumulative since commissioning (kWh)                     |
| Total discharged energy     | Cumulative since commissioning (kWh)                     |
| Battery charge power        | Current charge power (W)                                 |
| Battery discharge power     | Current discharge power (W)                              |
| Max charge power            | Configured maximum (W)                                   |
| Max discharge power         | Configured maximum (W)                                   |
| Daily charged energy        | Energy charged today (kWh)                               |
| Daily discharged energy     | Energy discharged today (kWh)                            |
| Battery status              | Operating state as text (e.g. Running, Standby)          |
| Installed battery modules   | Number of detected battery packs (read from registers 47750–47755) |

#### Controllable Values

| Capability                    | Options                                                                                              |
|-------------------------------|------------------------------------------------------------------------------------------------------|
| Storage working mode          | Adaptive · Fixed charge/discharge · Maximise self-consumption · TOU · Full feed-in · Third party    |
| Force charge/discharge        | Stop · Charge · Discharge                                                                            |
| Excess PV energy (TOU)        | Feed into grid · Charge battery                                                                      |
| Remote charge/discharge mode  | Local control · Max self-consumption · Full feed-in · TOU · AI · Third party                        |

---

### Battery LUNA2000 (EMMA Modbus)

Reads battery data via the EMMA Energy Management Module (unit ID 0).

#### Readable Values

| Capability               | Description                                          |
|--------------------------|------------------------------------------------------|
| Battery State Indicator  | Human-readable battery state: `850 W 🔺 (67%)` charging / `1200 W 🔻 (45%)` discharging / `(67%)` at idle / `Full (100%)` / `Empty (<5%)` — hidden in UI, available in flows |
| Battery power            | Current: positive = charging, negative = discharging (W) |
| State of charge          | SoC in percent (%)                                   |
| Backup SoC               | Reserved emergency SoC (%)                           |
| Chargeable capacity      | Currently available charge capacity (kWh)            |
| Dischargeable capacity   | Currently available discharge capacity (kWh)         |
| Total charged energy     | Cumulative since commissioning (kWh)                 |
| Total discharged energy  | Cumulative since commissioning (kWh)                 |
| Daily charged energy     | Energy charged today (kWh)                           |
| Daily discharged energy  | Energy discharged today (kWh)                        |

#### Controllable Values

| Capability                  | Options / Range                                                             |
|-----------------------------|-----------------------------------------------------------------------------|
| Storage working mode        | Self-consumption · Full feed-in · TOU · Third party                         |
| Excess PV energy (TOU)      | Feed into grid · Charge battery                                             |

#### Settings

| Setting                        | Description                                      |
|--------------------------------|--------------------------------------------------|
| Max grid charging power (kW)   | Writes register 40002 (0–50 kW, EMMA R/W)        |

---

### Power Meter (Modbus)

Direct Modbus TCP connection to the DTSU666 smart meter via SUN2000 / SDongle. Registered as a P1 meter (cumulative).

| Capability              | Description                                               |
|-------------------------|-----------------------------------------------------------|
| Grid State Indicator    | Human-readable grid state: `1234 W Import` / `1234 W Export` / `0 W` — hidden in UI, available in flows |
| Grid active power       | Current: positive = import, negative = export (W)         |
| Total grid import       | Cumulative total energy imported (kWh)                    |
| Total grid export       | Cumulative total energy exported (kWh)                    |
| Phase A/B/C voltage     | Phase voltages (V)                                        |
| Phase A/B/C current     | Phase currents (A)                                        |
| Phase A/B/C power       | Phase power (W)                                           |

---

### Power Meter (EMMA Modbus)

Reads grid data via the EMMA Energy Management Module (unit ID 0). Registered as a P1 meter (cumulative).

| Capability              | Description                                               |
|-------------------------|-----------------------------------------------------------|
| Grid State Indicator    | Human-readable grid state: `1234 W Import` / `1234 W Export` / `0 W` — hidden in UI, available in flows |
| Grid active power       | Current: positive = import, negative = export (W)         |
| Total grid import       | Cumulative total energy imported (kWh)                    |
| Total grid export       | Cumulative total energy exported (kWh)                    |
| Grid import today       | Energy imported from grid today (kWh)                     |
| Grid export today       | Energy exported to grid today (kWh)                       |
| House consumption       | Current house load / consumption power (W)                |
| House consumption today | Total consumption today (kWh)                             |

---

### Smart Charger (EMMA Modbus)

Reads EV charger data via the EMMA Energy Management Module.

| Capability           | Description                              |
|----------------------|------------------------------------------|
| Rated power          | Maximum charging power of the station (W)|
| Model name           | Charger product name                     |
| Phase A/B/C voltage  | Current phase voltages (V)               |
| Temperature          | Internal charger temperature (°C)        |
| Total energy charged | Cumulative since commissioning (kWh)     |

---

### Smart Charger (OCPP)

Runs an OCPP 1.6 JSON WebSocket server on port 8887 so compatible EV chargers (Huawei SCharger, Easee Home, and others) can connect directly to Homey without a cloud intermediary. One Homey device is created per charger (Station ID).

#### Readable Capabilities

| Capability              | Description                                                                      |
|-------------------------|----------------------------------------------------------------------------------|
| Charging (on/off)       | Native EV `evcharger_charging` control — on = actively charging (generates the standard "Start charging" / "Is charging" flow cards) |
| Target Charging Power   | Native EV `target_power` (W) — Homey/Energy dashboard set-point, mapped automatically to current and phase count (6 A minimum dead-zone) |
| Charging power          | Live AC charging power (W)                                                       |
| Target current (A)      | Active charging current limit (fine-grained amp control, kept in sync with Target Charging Power) |
| Charging energy         | Cumulative total energy (kWh)                                                    |
| Charging state          | `idle` / `connected` / `charging` / `finishing` / `fully_charged` / `error`     |
| Session status          | Human-readable session summary (e.g. "Charging · 3.2 kWh · 1h 12min")          |
| Charging profile        | Active limit display (e.g. "11 kW · 3-phase")                                   |
| Status summary          | Combined charger state line for the device card                                  |
| Phase currents L1/L2/L3 | Per-phase current (A) from MeterValues                                           |
| Phase voltages L1/L2/L3 | Per-phase voltage (V) from MeterValues                                           |
| Temperature             | Charger internal temperature (°C)                                                |
| Vehicle SoC             | Vehicle battery state of charge (%) — if charger supports it                    |
| OCPP server status      | WebSocket connection status and port                                             |
| Last OCPP message       | Timestamp of the last received OCPP message                                      |

#### Button Actions (device card)

| Button          | Description                                                           |
|-----------------|-----------------------------------------------------------------------|
| Pause charging  | Sends RemoteStop and stores session state for resume                  |
| Resume charging | Sends RemoteStart and restores the previous charging limit            |
| Release charger | Sends ChangeAvailability → Operative (unlocks stuck chargers)         |

#### Setup (Huawei SCharger)

Configure the SCharger via FusionSolar → *Device Commissioning* → *OCPP Settings*:

| SCharger field      | Value                                                                                      |
|---------------------|--------------------------------------------------------------------------------------------|
| Domain Name         | Homey's local IP address                                                                   |
| Path                | Your chosen Station ID (e.g. `scharger-home` or the serial number from the charger label) |
| Port                | `8887`                                                                                     |
| Mode                | Insecure transmission with basic authentication                                            |
| Username / Password | Optional — enter the same values in Homey settings if used                                 |

> The **Path** field in the SCharger is empty by default. You choose any unique identifier and enter the exact same value as **Station ID** in Homey. The value is case-sensitive.

#### Device Settings

| Setting                      | Default | Description                                                              |
|------------------------------|---------|--------------------------------------------------------------------------|
| Station ID                   | –       | Unique identifier matching the Path field on the charger                 |
| OCPP port                    | 8887    | WebSocket server port                                                    |
| Username / Password          | –       | Optional Basic Auth credentials (must match charger settings)            |
| Auto-start charging          | on      | Automatically starts charging when a car connects                        |
| Default charging current (A) | 16      | Current limit applied on each new session                                |
| Number of phases             | 3       | Phase count used for SetChargingProfile (1 or 3)                         |
| Charger model                | –       | Hardware variant (affects minimum current floor validation)              |
| Timeline notifications       | off     | Posts session start/stop events to the Homey timeline                    |

---

### Energy Management System (EMS)

A local orchestration device (Homey class `other`) that decides, every 15 seconds, how to use solar surplus. It reads your PV, house, grid and battery figures from the paired FusionSolar devices and drives loads — EV chargers, heat pump, boiler, pool pump, dehumidifier — plus battery and inverter export limits, prioritising free solar energy. No cloud, no external service; all logic runs on Homey.

**Control model:** the EMS does not write to other devices directly. Instead it **fires flow trigger cards** (e.g. *Set charger current*, *Start heat pump*) that you link to the corresponding device action cards in your own flows. This keeps it compatible with any charger/heat-pump brand, not just Huawei.

#### Capabilities

| Capability            | Description                                                                 |
|-----------------------|-----------------------------------------------------------------------------|
| Enabled (on/off)      | Master switch for the whole EMS                                              |
| Off-peak charging     | Enables cheap-tariff EV charging when solar is insufficient                  |
| Charge now            | One-tap override to charge the EV immediately                               |
| EMS mode              | Current decision (see modes below)                                          |
| Status text           | Human-readable summary of the active decision (e.g. `16A × 1 Lader · Bat 82%`) |
| Solar surplus (W)     | Live exportable surplus the EMS is allocating                               |
| PV / House / Grid / Battery power (W) | Live snapshot of the inputs driving the decision            |
| Electricity price     | Current tariff (fixed or from a variable-price flow)                        |

#### EMS Modes

`idle` · `disabled` · `not_configured` · `error` · `holding` · `battery_priority` · `solar_ev` · `offpeak_ev` · `instant_ev` · `solar_hp` (heat pump) · `solar_boiler` · `solar_pool` · `solar_dehumidifier` · `solar_multi` (several device types at once)

#### Controlled loads

| Load               | Behaviour                                                                                     |
|--------------------|-----------------------------------------------------------------------------------------------|
| EV chargers        | Solar-first current stepping (1/3-phase, per-charger min/max), off-peak fallback, per-car target SoC + car↔charger assignment |
| Heat pump / boiler / pool / dehumidifier | On/off from surplus with per-device start-up grace, min-run, stop-grace and max-run guards |
| Battery            | Reserve/hard-stop SoC zones; surplus is shared with loads before charging the battery         |
| Inverter export    | Optional export-limit coordinator (fires on/off triggers at a configurable SoC + export hold) |

#### Flow triggers (device: Energy Management System)

`ems_mode_changed`, `ems_set_charger_current`, `ems_start_charger`, `ems_start_heat_pump` / `ems_stop_heat_pump`, `ems_start_boiler` / `ems_stop_boiler`, `ems_start_pool` / `ems_stop_pool`, `ems_start_dehumidifier` / `ems_stop_dehumidifier`, `ems_battery_full`, `ems_battery_low`, `ems_battery_force_charge` / `ems_battery_force_discharge` / `ems_battery_normal_mode`, `ems_battery_max_charge_power` / `ems_battery_max_discharge_power`, `ems_inverter_export_limit_on` / `ems_inverter_export_limit_off`, `ems_inverter_set_power_w` / `ems_inverter_set_power_pct` / `ems_inverter_remove_limit`, `ems_set_car_target`

#### Flow actions

`ems_set_enabled`, `ems_set_electricity_price` (feed a variable tariff), `ems_set_car_target_soc`

#### Configuration & diagnostics

Data sources, controlled devices, tariff/automation and diagnostics are configured in **App Settings → Energy Management** (grouped by section). The settings page also shows an **EMS History** (recent mode/device/charger events, with a Copy button) and a live diagnostics view (`getEmsDiag`: tick health, last decision snapshot).

---

## Installation

### Requirements

#### Kiosk
- FusionSolar Kiosk URL (available in the FusionSolar app under Share → Kiosk URL)

#### OpenAPI (SUN2000 / LUNA2000 / iSitePower-M)
- FusionSolar account with Northbound API enabled
- Username and System Code (API password)
- Regional server, e.g. `https://intl.fusionsolar.huawei.com`

#### OCPP Smart Charger
- EV charger with OCPP 1.6 JSON support
- Charger and Homey on the same local network
- Port 8887 accessible (not blocked by firewall)

#### SDongle A
- SDongle A reachable over LAN
- Modbus TCP enabled (default port: **502**, alternative: **6607**)
- Modbus Unit ID: **100** (older firmware may use **0**)
- Static IP address recommended

#### Modbus (SUN2000 / LUNA2000 / DTSU666)
- SUN2000 inverter or SDongle reachable over LAN
- Modbus TCP enabled (default port: **502**, SDongle: **6607**)
- Static IP address recommended (DHCP reservation in router)

#### EMMA Modbus
- SUN2000MA Energy Management Module reachable over LAN
- Modbus TCP enabled (default port: **502**)
- Modbus Unit ID: **0**
- Static IP address recommended

### Setup in Homey

1. Install the app from the Homey App Store
2. Add a device: **Devices → + → Huawei FusionSolar Manager**
3. Select connection type and device, enter connection details
4. Connection test — on success the device is created

---

## Device Settings

### Kiosk

| Setting           | Default  | Description                                   |
|-------------------|----------|-----------------------------------------------|
| Kiosk URL         | –        | Public Kiosk URL of the plant                 |
| Update interval   | 10 min   | How often data is fetched (min. 10 min)       |

### OpenAPI (SUN2000 / LUNA2000 / iSitePower-M)

| Setting           | Default                         | Description                                   |
|-------------------|---------------------------------|-----------------------------------------------|
| Server URL        | intl.fusionsolar.huawei.com     | Regional FusionSolar API server               |
| Username          | –                               | FusionSolar API username                      |
| System Code       | –                               | API password                                  |
| Station Code      | –                               | Set automatically during pairing              |
| Update interval   | 5 min                           | How often data is fetched (min. 1 min)        |

> **Rate limiting:** Huawei may return HTTP 407 if polling too frequently. The default of 5 minutes is recommended. Values below 5 minutes may cause temporary data gaps.

### SUN2000 (Modbus)

#### Connection

| Setting              | Default | Description                                   |
|----------------------|---------|-----------------------------------------------|
| IP address           | –       | IP of the SUN2000 / SDongle                   |
| Modbus port          | 502     | SDongle typically uses 6607                   |
| Modbus unit ID       | 1       | Unit ID of the device (default: 1)            |
| Update interval (s)  | 60      | How often data is polled (min. 10 s)          |

#### Feed-in Power Control

These values are read from the inverter on startup and kept in sync.

| Setting                    | Default | Description                                                                          |
|----------------------------|---------|--------------------------------------------------------------------------------------|
| Max feed-in power (W)      | –       | Maximum grid feed-in power in watts (register 47416). Set to 0 to block all export. |
| Max feed-in power (%)      | –       | Maximum grid feed-in power as % of rated power (register 47418).                    |

#### Output Limit (without Smart Power Sensor)

These registers derate the inverter AC output directly and work without a DTSU666.

| Setting                   | Default | Description                                                                         |
|---------------------------|---------|-------------------------------------------------------------------------------------|
| Output limit (W)          | –       | Absolute output cap in watts (register 40126). Set to 0 for no limit.              |
| Output limit (%)          | –       | Output cap as % of rated power (register 40125). Set to 100 for no limit.          |

### LUNA2000 / DTSU666 (Modbus)

| Setting              | Default | Description                                   |
|----------------------|---------|-----------------------------------------------|
| IP address           | –       | IP of the SUN2000 / SDongle                   |
| Modbus port          | 502     | SDongle typically uses 6607                   |
| Modbus unit ID       | 1       | Unit ID of the device (default: 1)            |
| Update interval (s)  | 60      | How often data is polled (min. 10 s)          |

### SDongle A Modbus

| Setting              | Default | Description                                   |
|----------------------|---------|-----------------------------------------------|
| IP address           | –       | IP of the SDongle A                           |
| Modbus port          | 502     | Alternative: 6607                             |
| Modbus unit ID       | 100     | Older firmware may use 0                      |
| Update interval (s)  | 60      | How often data is polled (min. 10 s)          |

### EMMA Modbus

| Setting                         | Default | Description                                      |
|---------------------------------|---------|--------------------------------------------------|
| IP address                      | –       | IP of the EMMA Energy Management Module          |
| Modbus port                     | 502     | Default port of the EMMA                         |
| Modbus unit ID                  | 0       | EMMA uses unit ID 0                              |
| Update interval (s)             | 60      | How often data is polled (min. 10 s)             |
| Max grid charging power (kW)    | 5       | Battery only: writes EMMA register 40002         |

---

## Flow Cards

### Triggers

| Card                                     | Device                          | Tokens                                               | Description                                                              |
|------------------------------------------|---------------------------------|------------------------------------------------------|--------------------------------------------------------------------------|
| Power output changed                     | Kiosk                           | `power` (W)                                          | Fires on every power change                                              |
| Daily yield updated                      | Kiosk                           | `daily_energy`                                       | Fires when daily yield is updated                                        |
| Power output changed                     | Inverter SUN2000 Modbus/EMMA    | `power` (W)                                          | Fires on every power change                                              |
| Power output changed                     | Inverter SUN2000 OpenAPI        | `power` (W)                                          | Fires on every power change                                              |
| Battery SoC changed                      | LUNA2000 Modbus/EMMA            | `soc` (%)                                            | Fires on every SoC change                                                |
| Battery charging state changed           | LUNA2000 Modbus/EMMA            | `state`                                              | `charging` / `discharging` / `idle`                                     |
| Battery working mode changed             | LUNA2000 Modbus/EMMA            | `mode`                                               | Fires when the storage working mode changes                              |
| Excess PV energy use changed             | LUNA2000 Modbus/EMMA            | `mode`                                               | Fires when switching between Feed to Grid / Charge Battery               |
| Remote dispatch mode changed             | LUNA2000 Modbus                 | `mode`                                               | Fires when the remote charge/discharge control mode changes              |
| Battery SoC changed                      | Battery OpenAPI                 | `soc` (%)                                            | Fires on every SoC change                                                |
| Battery charging state changed           | Battery OpenAPI                 | `state`                                              | `charging` / `discharging` / `idle`                                     |
| Grid export started                      | Power Meter Modbus/EMMA         | `power` (W)                                          | Fires when switching from import to export                               |
| Grid import started                      | Power Meter Modbus/EMMA         | `power` (W)                                          | Fires when switching from export to import                               |
| Inverter status changed                  | Inverter SUN2000 Modbus         | `status`                                             | Fires when the inverter operating state changes (timeline notification)  |
| Battery status changed                   | LUNA2000 Modbus                 | `status`                                             | Fires when the battery state changes (timeline notification)             |
| Meter status changed                     | Power Meter DTSU666 Modbus      | `status`                                             | Fires when the meter state changes (timeline notification)               |
| Charging session started                 | Smart Charger (OCPP)            | `amps`, `phases`, `phase_label`, `message`           | Fires when a vehicle starts charging (power confirmed > 100 W)          |
| Charging session stopped                 | Smart Charger (OCPP)            | `energy_wh`, `energy_formatted`, `duration`, `amps`, `phases`, `message` | Fires when a vehicle stops charging (StopTransaction received) |
| Car plugged in, waiting                  | Smart Charger (OCPP)            | –                                                    | Fires when a car connects but auto-start is off or session is blocked    |
| Charging state changed                   | Smart Charger (OCPP)            | `state`                                              | Fires on every charging state transition                                 |
| Charger offline                          | Smart Charger (OCPP)            | `message`                                            | Fires when no OCPP message has been received for 3 minutes               |
| Charger back online                      | Smart Charger (OCPP)            | `message`                                            | Fires when the charger reconnects after being offline                    |
| Charging paused                          | Smart Charger (OCPP)            | –                                                    | Fires when a session is paused via the Pause button or flow action       |
| Charging resumed                         | Smart Charger (OCPP)            | `amps`, `phases`, `phase_label`, `message`           | Fires when a paused session is resumed                                   |
| Charging limit changed                   | Smart Charger (OCPP)            | `amps`, `previous_amps`, `phases`, `phase_label`, `message` | Fires when the SetChargingProfile limit is changed during a session |
| Charger disconnected                     | Smart Charger (OCPP)            | –                                                    | Fires when the OCPP WebSocket connection drops                           |

### Conditions

| Card                                      | Device                          | Description                                                                         |
|-------------------------------------------|---------------------------------|-------------------------------------------------------------------------------------|
| Is currently producing                    | Kiosk                           | Checks if the plant is currently generating                                         |
| Is currently producing                    | Inverter SUN2000 Modbus/EMMA    | Checks if the inverter is currently generating                                      |
| Solar power above value for duration      | Inverter SUN2000 Modbus/EMMA    | True if solar power has been above the threshold for at least N minutes             |
| Solar power below value for duration      | Inverter SUN2000 Modbus/EMMA    | True if solar power has been below the threshold for at least N minutes             |
| Battery SoC is above threshold            | LUNA2000 Modbus/EMMA/OpenAPI    | True if current SoC (%) is strictly above the configured value                     |
| Battery SoC is below threshold            | LUNA2000 Modbus/EMMA/OpenAPI    | True if current SoC (%) is strictly below the configured value                     |
| Battery is charging                       | LUNA2000 Modbus                 | True when the battery is actively charging                                          |
| Battery is discharging                    | LUNA2000 Modbus                 | True when the battery is actively discharging                                       |
| Battery status is                         | LUNA2000 Modbus                 | Checks the current battery operating state string                                   |
| Storage working mode is                   | LUNA2000 Modbus/EMMA            | Checks the current storage working mode                                             |
| Excess PV use is                          | LUNA2000 Modbus/EMMA            | Checks whether excess PV is set to feed-in or charge battery                        |
| Remote charge/discharge mode is           | LUNA2000 Modbus                 | Checks the current remote dispatch control mode                                     |
| Max charge power is above threshold       | LUNA2000 Modbus                 | True when register 47075 (max charge power) is above the given W value. Use "NOT below 1 W" to check if the limit has already been zeroed. |
| Max charge power is below threshold       | LUNA2000 Modbus                 | True when register 47075 (max charge power) is below the given W value. Threshold 1 checks whether the limit is already set to 0. |
| Grid is exporting                         | Power Meter Modbus/EMMA/OpenAPI | True when the meter reports negative active power (surplus fed to grid)             |
| Meter status is                           | Power Meter DTSU666 Modbus      | Checks the current meter online/offline status                                      |

### Actions

#### Inverter SUN2000 (Modbus)

| Card                              | Description                                                                                        |
|-----------------------------------|----------------------------------------------------------------------------------------------------|
| Set active power control mode     | Sets the inverter feed-in mode (reg 40029): No limit · Feed-in limitation · Zero export · etc.    |
| Set max feed-in power (W)         | Sets the maximum grid feed-in power in watts (reg 47416). Requires DTSU666.                        |
| Set max feed-in power (%)         | Sets the maximum grid feed-in power as % of rated power (reg 47418). Requires DTSU666.             |
| Set max charge power (W)          | Sets the maximum battery charge power in watts (reg 47075).                                         |
| Set max discharge power (W)       | Sets the maximum battery discharge power in watts (reg 47077).                                      |
| Set inverter output limit (W)     | Caps inverter AC output in watts (reg 40126). Works without DTSU666.                               |
| Set inverter output limit (%)     | Caps inverter AC output as % of rated power (reg 40125). Works without DTSU666.                    |
| Remove inverter output limit      | Resets regs 40125/40126 to disable the output limit (sets 40125 = 100%, 40126 = 0).               |

#### Battery LUNA2000 (Modbus)

| Card                              | Description                                                                                        |
|-----------------------------------|----------------------------------------------------------------------------------------------------|
| Set storage working mode          | Sets the battery operating mode (self-consumption / TOU / full feed-in / etc.)                    |
| Force charge                      | Forces immediate battery charging at the specified power                                           |
| Force discharge                   | Forces immediate battery discharging at the specified power                                        |
| Set max charge power (W)          | Sets the maximum battery charge power (reg 47075)                                                  |
| Set max discharge power (W)       | Sets the maximum battery discharge power (reg 47077)                                               |
| Set grid charge power (W)         | Sets the active grid-to-battery charge power setpoint (reg 47242)                                  |
| Set grid charge cutoff SoC (%)    | Sets the SoC at which grid charging stops (reg 47246)                                              |

#### Battery LUNA2000 (EMMA Modbus)

| Card                              | Description                                                                                        |
|-----------------------------------|----------------------------------------------------------------------------------------------------|
| Set storage working mode          | Sets the battery operating mode (self-consumption / TOU / full feed-in / etc.)                    |
| Force charge                      | Forces immediate battery charging at the specified power                                           |
| Force discharge                   | Forces immediate battery discharging at the specified power                                        |
| Set max grid charging power (kW)  | Sets the max grid charge power on the EMMA (reg 40002)                                             |

#### Smart Charger (OCPP)

| Card                                         | Description                                                                                            |
|----------------------------------------------|--------------------------------------------------------------------------------------------------------|
| Start charging                               | Sends RemoteStartTransaction; applies pending current limit beforehand                                 |
| Start charging at X A (N-phase)              | Starts a session with an explicit current and phase override                                           |
| Stop charging                                | Sends RemoteStopTransaction to the active session                                                      |
| Pause charging                               | Masked pause: stops the current session and saves state for resume                                     |
| Resume charging                              | Restores the paused session with the previous current limit                                            |
| Set charging limit to X A                   | Sends SetChargingProfile (TxProfile during session / TxDefaultProfile otherwise) in Watts/Absolute     |
| Set charging limit to X A (N-phase)          | Same as above with an explicit phase override                                                          |
| Release charger                              | Sends ChangeAvailability → Operative (unblocks a charger stuck in Unavailable state)                   |
| Reboot charger (Soft / Hard)                 | Sends OCPP Reset and suppresses the offline watchdog alert for 5 minutes                               |

---

## Energy Dashboard

The app is fully configured for the Homey Energy Dashboard:

| Device                          | Homey category        | Function                                                  |
|---------------------------------|-----------------------|-----------------------------------------------------------|
| Kiosk                           | Solar panel           | Total yield → Generated energy                            |
| Inverter SUN2000 OpenAPI        | Solar panel           | Inverter total yield → Generated energy                   |
| Inverter SUN2000 Modbus         | Solar panel           | Total yield → Generated energy                            |
| Inverter SUN2000 EMMA Modbus    | Solar panel           | Total yield → Generated energy                            |
| iSitePower-M Solar              | Solar panel           | Total yield → Generated energy                            |
| Battery LUNA2000 OpenAPI        | Home battery          | Charge and discharge power                                |
| Battery LUNA2000 Modbus         | Home battery          | Charged / discharged energy + charge/discharge power      |
| Battery LUNA2000 EMMA Modbus    | Home battery          | Charged / discharged energy + charge/discharge power      |
| iSitePower-M Battery            | Home battery          | Charged / discharged energy + charge/discharge power      |
| Power Meter OpenAPI             | P1 meter (cumulative) | Grid import + grid export                                 |
| Power Meter Modbus              | P1 meter (cumulative) | Grid import + grid export                                 |
| Power Meter EMMA Modbus         | P1 meter (cumulative) | Grid import + grid export                                 |
| iSitePower-M Grid               | P1 meter (cumulative) | Grid import (direct from Mains meter or energy balance)   |
| iSitePower-M Home               | Energy consumer       | Total home consumption (cumulative kWh)                   |

All LUNA2000 and iSitePower-M Battery variants are declared with `"batteries": ["INTERNAL"]` so Homey correctly identifies them as built-in home batteries in the Energy Dashboard.

---

## Dashboard Widgets

The app includes 9 Homey dashboard widgets that provide live and daily energy data at a glance. Widgets are added via **Homey → Dashboard → + → Huawei FusionSolar Manager**.

All widgets prefer `sun2000_modbus` / `luna2000_modbus` as their primary data source and fall back to EMMA or SDongle A variants when those are not paired.

---

### Solar Power Flow

A hub-layout widget showing real-time power flows between PV, house, grid and battery.

```
          ☀️  Solar PV
               |
  ⚡ Netz ────●──── 🔋 Batterie
               |
           🏠  Haus
```

- **Animated flow lines** — dashed lines move in the direction of actual energy flow, coloured by source (amber = PV, blue = house, green = charge/export, orange = discharge, red = import)
- **Hub circle** — ⚡ icon with colour-coded border:
  - 🟢 Green: PV producing, no grid import
  - 🟠 Orange: no PV, battery discharging (covering load)
  - 🔴 Red: grid import active
  - No border: night / standby
- **Battery node** shows SoC % below the power value; faded when no LUNA2000 is paired
- Updates every **5 seconds**

| Widget setting           | Default | Description                                              |
|--------------------------|---------|----------------------------------------------------------|
| Activity threshold (W)   | 50 W    | Minimum power to show a flow as active (reduce flickering) |

---

### Grid Status (Netzampel)

A compact status widget with a pulsing colour circle indicating the current grid state.

- 🟢 **Green pulse** — exporting to grid (Einspeisung)
- 🔴 **Red pulse** — importing from grid (Netzbezug)
- 🟡 **Yellow pulse** — self-sufficient (PV covers load exactly)
- Stats row shows current PV power, battery power + SoC, and house consumption
- Battery stat is hidden when no LUNA2000 is paired
- Updates every **5 seconds**

| Widget setting           | Default | Description                                              |
|--------------------------|---------|----------------------------------------------------------|
| Activity threshold (W)   | 50 W    | Minimum power for state changes (reduce flickering)      |

---

### Energy Balance (Energiebilanz)

Daily energy totals shown as relative bars, plus self-consumption and self-sufficiency metrics.

| Bar               | Source                                                                        |
|-------------------|-------------------------------------------------------------------------------|
| PV today          | `sun2000_modbus` → `meter_power.daily` (register 32114, resets at midnight)  |
| Grid export today | `sun2000_modbus` → cumulative delta from midnight baseline                    |
| Grid import today | `sun2000_modbus` → cumulative delta from midnight baseline                    |
| House consumption | Calculated: self-consumed PV + grid import                                    |

> **Midnight baseline:** the app records the cumulative grid export/import counter at 00:00:05 each night. Daily values are derived as `current − baseline`. If the app was not running at midnight the baseline is written on the next start. A hint is shown in the widget until the baseline is available.

- **Eigenverbrauch %** — share of PV energy used on-site (not exported)
- **Autarkie %** — share of total consumption covered by PV
- Battery charged / discharged row is shown only when a LUNA2000 is paired
- Updates every **10 seconds**

---

### Battery Status (Batteriestatus)

Detailed battery state at a glance.

- **SoC bar** — colour coded: green ≥ 40 %, orange 20–40 %, red < 20 %
- **Charge / discharge power** with direction label and animated glow icon
- **Time remaining** — estimated time to full (when charging) or empty (when discharging), shown prominently below the SoC bar
- **Today's stats** — energy charged and discharged today (kWh)
- Shows **"Keine Batterie"** when no LUNA2000 is paired
- Updates every **10 seconds**

| Widget setting             | Default | Description                                                   |
|----------------------------|---------|---------------------------------------------------------------|
| Battery capacity (kWh)     | 5 kWh   | Usable capacity used to calculate remaining time. LUNA2000 examples: 1 module = 5 kWh, 2 modules = 10 kWh |

---

### Daily Yield (Tagesertrag)

At-a-glance summary of today's solar production.

- **Today's yield** — large display in kWh (auto-scales to MWh above 1 000 kWh)
- **Lifetime total** — cumulative yield since commissioning
- **Optimizer count** — online / total (shown only when optimizers are detected)
- **CO₂ saved** — calculated from today's yield × emission factor
- Updates every **10 seconds**

| Widget setting              | Default     | Description                                                        |
|-----------------------------|-------------|--------------------------------------------------------------------|
| CO₂ factor (g/kWh)          | 401 g/kWh   | Grid emission factor. DE = 401, CH = 29, AT = 108, EU avg = 255   |

---

### Charger Status (Ladestatus)

Live state of an EV charger (OCPP or EMMA): charging power, session energy, active current/phase limit and connection state at a glance.

---

### Charging Sessions (Ladesitzungen)

A scrollable history of completed charging sessions — energy delivered, duration and end reason per session (OCPP charger).

---

### EMS History (EMS Verlauf)

Recent Energy Management System events — mode changes, device start/stop and charger current steps — the same feed shown in App Settings, on your dashboard.

---

### Sensor Chart (Sensor-Verlauf)

A configurable time-series chart of a chosen capability (e.g. solar power, grid power, SoC), for a quick trend view directly on the dashboard.

---

## Technical Background

- **Kiosk:** HTTP polling of the public FusionSolar Kiosk API
- **OpenAPI:** HTTPS connection to the Huawei FusionSolar Northbound API (xsrf-token authentication, automatic re-login on session expiry). Devices from the same plant share a common session and coordinator — one API call per interval for all devices of the same plant
- **Modbus (SUN2000/SDongle):** TCP connection via [`jsmodbus`](https://www.npmjs.com/package/jsmodbus) following the Huawei SUN2000 Modbus Interface Definition A. All Modbus devices on the same host share a serialised queue (`withHostLock`) — no concurrent connections
- **EMMA Modbus:** TCP connection to the SUN2000MA Energy Management Module (unit ID 0). All three EMMA device types (inverter, battery, meter) read from the same EMMA register range — no SDongle or DTSU666 required. R/W access to ESS control registers (40000–40002) via FC06/FC16
- **Energy Management System:** A 15-second decision loop running on Homey. Reads PV/house/grid/battery from the paired devices, allocates solar surplus across a fixed load priority (instant → battery-protect → EV solar/off-peak → simple loads), and acts by firing flow trigger cards rather than writing to devices directly (brand-agnostic). Internally modular (`lib/ems/*` mixins: charger control, simple devices, battery zones, price, export limit, history) with debounced history persistence, config validation and a diagnostics snapshot (`getEmsDiag`). Core decision logic is covered by unit tests (`node --test`).
- **OCPP 1.6:** Singleton WebSocket server (port 8887) running inside Homey. Implements BootNotification, Heartbeat, StatusNotification, MeterValues, StartTransaction, StopTransaction, Authorize, DataTransfer. Outgoing calls are fully async with response tracking (`_pendingCalls` map, 10 s timeout): RemoteStartTransaction, RemoteStopTransaction, SetChargingProfile (TxDefaultProfile stackLevel 0 / TxProfile stackLevel 1, `chargingRateUnit: 'W'`, Absolute kind), ChangeAvailability, Reset. SetChargingProfile uses Watts (0 A → 1 W to work around a Huawei firmware bug where a 0 W TxDefaultProfile is unreliable). Supports optional HTTP Basic Authentication per station. Station ID is extracted from the WebSocket URL path (`ws://homey-ip:8887/[station-id]`). Masked Pause/Resume stitches two physical transactions into a single logical session preserving cumulative energy and start time. Power-verified start: the `charging_started` trigger fires only after > 100 W is confirmed (90 s watchdog). Offline watchdog triggers a flow card after 3 minutes of silence and suppresses alerts for 5 minutes after a reboot command.

---

## License

MIT License – see [LICENSE](LICENSE)

---

## Support

If this app saves you time or money, a small donation is always appreciated:

[![Donate via PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/AndiWirz)

---

## AI Development

This app was developed entirely with the assistance of **Claude (Anthropic AI)**.
