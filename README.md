# Hive-style thermostat cards for Home Assistant

[![HACS Custom](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://hacs.xyz/docs/faq/custom_repositories)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-%E2%98%95-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/xtrendmaster)

A clean, phone-first heating dashboard for Home Assistant, inspired by the look and feel of the Hive app, with a few things the app can't do.

> **Not affiliated with, endorsed by or connected to Hive or Centrica.** "Hive" is used only to describe compatibility with the Home Assistant Hive integration.

![Hive-style heating for Home Assistant](images/hero.gif)

![Home](images/home.png) ![Thermostat](images/thermostat.png) ![Picker](images/picker.png) ![Schedule](images/schedule.png)

## Features

- **Hive-style home screen**: big "Actual" temperature, target with a flame or tick, Boost pill on every card.
- **Thermostat page**: colour gradient that follows the target (blue at 5° through orange to red at 30°), a moving scale, up/down arrows and Manual / Schedule / Off.
- **Hold-to-scroll temperature wheel** (`custom:hive-temp-picker`): the selected number glows and the colour changes as you scroll.
- **Heating schedule in Home Assistant** (`custom:hive-schedule-card`): a Hive-style day view with an editor. Tap a slot to change start, end and temperature, add or delete periods, or copy a day to other days. It works with the [Scheduler component](https://github.com/nielsfaber/scheduler-component).
- **Advance to next** slot, like the app.
- **Boost like the Hive app**: tap Boost, pick the temperature and how long. On the main thermostat you can boost all the radiators too.
- **Boost for any radiator valve**: Hive valves use Hive's own boost; other valves (Sonoff, Aqara, Tuya…) get a Home Assistant boost that puts them back how they were when it ends.
- **Hot water** page with boost and On / Schedule / Off, and its own **hot water schedule** run by Home Assistant (same editor, On/Off slots).
- **Light, dark or automatic** appearance, switchable on the Manage page.
- **Valve batteries** at a glance on the Manage page, plus a small warning on a radiator's page when its battery is low.
- **Insights**: temperature charts with apexcharts-card.
- **Manage**: one place for modes, away mode and device health.
- **Gentle on Hive's servers**: the wheel and arrows wait until you've finished, then send one change (never more than one every 10 seconds per thermostat). A small "Setting 19.5°" bubble shows the change is on its way.

## Requirements

Install these first, from HACS unless noted:

| Needed for | Project |
|---|---|
| Hive devices | Home Assistant **Hive** integration (built in) |
| Layout and styling | [button-card](https://github.com/custom-cards/button-card), [card-mod](https://github.com/thomasloven/lovelace-card-mod) |
| Bottom menu | [navbar-card](https://github.com/joseluis9595/lovelace-navbar-card) |
| Schedules | [Scheduler component](https://github.com/nielsfaber/scheduler-component) (integration) + [Scheduler card](https://github.com/nielsfaber/scheduler-card) |
| Charts | [apexcharts-card](https://github.com/RomRider/apexcharts-card) |
| Optional, full-screen look | [kiosk-mode](https://github.com/NemesisRE/kiosk-mode) |

## Installation

**Before you start:** in the Hive app, set your heating to **Manual**. Home Assistant runs the schedule from now on.

1. **Install the cards.** HACS → ⋮ → *Custom repositories* → add `https://github.com/xtrendmaster/hive-style-thermostat-cards`, type *Dashboard*. Install **Hive-style Thermostat Cards**, then reload the browser (or close and reopen the app).
2. **Make an empty dashboard.** *Settings → Dashboards → Add dashboard → New dashboard from scratch*. Give it a name (e.g. *Heating*) and open it.
3. **Add the setup card.** *✏️ Edit → Add card*, search for **Hive-style heating setup**, add it and click *Done*.
4. **Pick your devices.** Choose your thermostat, hot water and radiator valves from the lists (you can rename the valves). The Hive boost sensors are found automatically.
5. **Press "Create my heating dashboard".** It creates the switches, boost timers and scripts it needs and builds the whole dashboard: home screen, thermostat, hot water, one page per radiator, schedule, insights and manage. No YAML, no restart.

To change things later (a new valve, a different name), open **Manage → Heating setup** and press *Update*.

The setup page checks you have the other cards it needs (see Requirements) and tells you if one is missing.

### Manual setup (advanced)

Prefer YAML? Copy `package/hive_style_heating.yaml` to `/config/packages/` (with `homeassistant: packages: !include_dir_named packages` in `configuration.yaml`), edit the entity IDs at the top and restart. Then paste `examples/dashboard.yaml` into a new dashboard's *Raw configuration editor* and replace the example entity IDs:

| Example | What it is |
|---|---|
| `climate.hive_thermostat` | Hive heating thermostat |
| `water_heater.hive_hot_water` | Hive hot water |
| `binary_sensor.hive_thermostat_boost` / `binary_sensor.hive_hot_water_boost` | Hive boost sensors |
| `binary_sensor.hive_hot_water_state` | Hive hot water on/off |
| `climate.bedroom_radiator` | A Hive radiator valve |
| `climate.study_radiator` + `timer.boost_study_radiator` | Any other valve and its boost timer |

Don't use both: the setup page leaves scripts that come from a YAML package alone.

## Not using Hive?

The dashboard should work with any thermostat and radiator valves Home Assistant can set a temperature on (e.g. Netatmo, Tado, Nest, Sonoff, Aqara, Tuya, `generic_thermostat`). It's tested with Hive and a standard Home Assistant thermostat; tell me in Issues how yours gets on. On the setup page pick your thermostat and choose **Connected through: Another thermostat**. Temperature, the schedule, Manual / Schedule / Off, Boost and the charts all work. Hot water currently needs Hive's hot water.

## Zigbee2MQTT (local) - beta

If your Hive receiver and thermostat are paired to **Zigbee2MQTT** instead of the Hive hub, pick your receiver as the main thermostat on the setup page and choose **Connected through: Zigbee2MQTT (local)**. Check the receiver's topic (e.g. `zigbee2mqtt/Hive Receiver`) and whether it's single channel (SLR1) or dual channel (SLR2).

- **Boost** uses the receiver's own timed boost over MQTT. Home Assistant keeps a timer (`timer.boost_<receiver>`) so the dashboard knows a boost is running.
- **When a boost is cancelled or runs out**, the receiver's boost is cleared and the heating is put back how it was before the boost, then the Home Assistant schedule is reapplied if it's on. (The receiver doesn't always restore the right target by itself.)
- Heating on/off, the schedule and Manual / Schedule / Off work as normal.
- **Not yet:** hot water over Zigbee2MQTT (choose *No hot water* for now), and dual-channel receivers are untested. Feedback welcome in Issues.

Thanks to Matt Sol for working out and testing the receiver's MQTT messages.

## Using the cards on their own

```yaml
type: custom:hive-temp-picker
entity: climate.hive_thermostat
name: Thermostat
back_path: /hive-heating/thermostat   # where the back arrow goes
insights_path: /hive-heating/insights
min: 5
max: 30
step: 0.5
```

```yaml
type: custom:hive-schedule-card
entity: climate.hive_thermostat
title: Thermostat
tag: hive_heating                     # schedules with this tag are shown and edited
mode_entity: input_boolean.hive_ha_schedule
default_temp: 18.5
back_path: /hive-heating/thermostat
edit_path: /hive-heating/schedule-edit
```

## Radiator valves and heating single rooms

**Mix Hive and other smart valves.** Hive radiator valves work well but are expensive, and doing a whole house with them adds up. You can add cheaper Zigbee valves (Sonoff, Aqara, Tuya…) for the other rooms. On this dashboard they all sit on one screen, look the same and Boost the same way, and because everything is in Home Assistant you can use them in your own automations too.

**How a single room heats.** A radiator valve only opens or closes; the boiler fires only when the main thermostat asks for heat. So boosting one valve while the heating is off on the schedule warms that room only if the boiler is running. A "rooms call the boiler" option, which turns the main thermostat up for a while and then puts it back, is being tested.

**While the boiler runs:**
- Smart valves set lower than their room's temperature stay closed, so those rooms don't heat.
- Radiators **without** a smart valve heat up as normal, because nothing tells them to stay closed (a normal TRV only shuts once its room is already warm). For real room-by-room control, fit smart valves to the rooms you use most first; the rest can come later.
- Most systems have a bypass valve or a towel rail without a TRV, so the boiler always has somewhere to send the water when nearly every valve is closed. If you're not sure about yours, ask a heating engineer when you fit smart valves.

## Good to know

- **"Off" in a schedule is 7°**, Hive's frost setting, so the boiler still protects the house.
- **Don't use Hive's own schedule at the same time.** If someone selects Schedule in the Hive app, the two schedules will fight. Use the dashboard's Schedule button instead.
- **Hive's servers block bursts of changes.** Several temperature changes within a few seconds make Hive answer with HTTP 403 "Token expired or forbidden" for a few minutes, even though nothing is wrong with your login. The cards' write gate prevents this. If you add your own buttons, use `tap_action: {action: fire-dom-event, hive_nudge: {entity_id: climate.x, delta: 0.5}}` (or `hive_set: {entity_id, temperature}`) rather than calling `climate.set_temperature` on every tap. If you do see a 403, wait 5–10 minutes before changing anything; don't delete and re-add the integration.
- **Hive needs the internet.** Every change goes through Hive's cloud, so a DNS or broadband blip makes a change fail. Locally controlled valves (Zigbee via ZHA or Zigbee2MQTT) aren't affected.
- **Hive radiator valves**: the integration's "boost off" doesn't work on them, so the package cancels a valve boost by restoring a snapshot taken when the boost started. If Home Assistant restarts mid-boost, the snapshot is lost and the valve turns off.
- **Faint boxes behind titles or empty space?** A "frosted glass" style Home Assistant theme draws a box around every card. The dashboard does its own light and dark look, so set your profile's **Theme** to **Use default theme** (tap your name at the bottom of the sidebar).
- The cards save the whole day back to Scheduler when you edit it. Editing one day of a shared schedule (e.g. Tue–Fri) splits that day into its own schedule.

## Changelog

- **1.6.0-beta.7**: Zigbee2MQTT receivers: cancelling or ending a boost could leave the receiver at 1 °C when it had been in Auto. The boost now always takes a snapshot first, restores it, and checks again a few seconds later in case the receiver drops to 1 °C late. Thanks Matt Sol.
- **1.6.0-beta.6**: **Boost all radiators too**: a switch in the main thermostat's Boost pop-up that also boosts every smart radiator valve to the same temperature for the same time (Hive valves are boosted a few seconds apart so Hive doesn't block them). Stopping the main boost stops those radiators too; rooms you boosted on their own are left alone. The pop-up now shows the names from your dashboard. Idea from Matt Sol.
- **1.6.0-beta.5**: radiator valves with their own *boost* preset (Tuya, Moes, Sonoff…) were mistaken for Hive valves and Boost failed with "hive.boost_heating_on not found". Only valves from the Hive integration are treated as Hive now; the others get a Home Assistant boost. The setup page is also better at picking the main thermostat (it skips radiator valves and hot tubs). Already set up? Press *Update* on the setup page with *Also replace heating scripts I made myself* ticked.
- **1.6.0-beta.4**: works with **any thermostat** in Home Assistant, not just Hive: on the setup page choose *Connected through: Another thermostat*. Boost sets the temperature you pick, and a Home Assistant timer puts the thermostat back how it was when the boost ends. *Schedule* on a thermostat without an auto mode now falls back to heat instead of failing.
- **1.6.0-beta.3**: fully local Zigbee2MQTT setups (no Hive integration) no longer include any `hive.*` actions in the scripts, so Spook and the repairs list stay clean. Thanks Matt Sol.
- **1.6.0-beta.2**: tap **Boost** to choose the temperature and how long (30 min to 3 hr), like the Hive app; hot water just asks how long. Your last choice is remembered. Tap **Boosting** to stop. Press and hold Boost for a quick 21° / 1 hr boost. Idea from Matt Sol.
- **1.6.0-beta.1**: Zigbee2MQTT (local) option on the setup page: Boost through the receiver's own timed boost, with a Home Assistant timer and clean-up so the heating is always put back afterwards.
- **1.5.2**: setup page: choosing *No hot water* hides the hot water sensor questions.
- **1.5.1**: heating-only homes (hot water set to *No hot water*): the setup page now leaves every hot water part out of the scripts, so there are no placeholder entities like `water_heater.none`. If no thermostat boost sensor is picked, boost is read from the thermostat itself. Already set up? Press *Update* with *Also replace heating scripts I made myself* ticked once. Thanks Matt.
- **1.5.0**: hot water schedule in Home Assistant; Light / Dark / Auto appearance; valve battery card; the setup page checks for the Scheduler card and accepts UIX instead of card-mod. The setup page now leaves heating scripts you made yourself alone (tick *Also replace heating scripts I made myself* to update them; needed once if you set up with 1.4.x and want the hot water schedule).
- **1.4.1**: the setup page only works after the card is saved (not in the card editor preview), and if heating scripts already exist it leaves them alone unless you untick *Dashboard only*.
- **1.4.0**: new **setup page** (`custom:hive-setup-card`): pick your thermostat, hot water and valves and it builds the whole dashboard, with no YAML. Fixed: cancelling a boost now puts the valve back how it was (it was switching it off).
- **1.3.2**: the schedule card follows the dashboard's light/dark colours (`--hs-*` CSS variables) and shows a message if saving fails.
- **1.3.1**: the schedule editor accepts any minute (not only 15-minute steps). There's no limit on periods per day.
- **1.3.0**: the scroll wheel automatically shows the room's photo if the radiator's Area has a picture (Settings > Areas). `photo:` still overrides it; `area_photo: false` turns it off.
- **1.2.0**: `hive-temp-picker` takes an optional `photo:` (image URL) shown softly behind the colour.
- **1.1.0**: write gate. The wheel and arrows batch changes so Hive doesn't block them; "Setting…" bubble; the wheel never sends a value you didn't choose (e.g. after a reconnect).
- **1.0.0**: first release.

## Support

This project is free. If it saves you time, you can [buy me a coffee ☕](https://buymeacoffee.com/xtrendmaster). Bugs and ideas go in the **Issues** tab.

## Credits

Built on the work of button-card, card-mod, navbar-card, Scheduler component and card, and apexcharts-card. Fonts: [DM Serif Display](https://fonts.google.com/specimen/DM+Serif+Display) and [Inter](https://fonts.google.com/specimen/Inter) (SIL Open Font License).

## Licence

[MIT](LICENSE)
