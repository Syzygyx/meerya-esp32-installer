# Meerya Rev.C Nordic development firmware

Target: Qorvo DWM3001CTR13 module (nRF52833 + DW3110), QANI / Apple Nearby Interaction, Nordic S113 7.2.0, Secure BLE DFU.

## Artifacts

- `revc-apple-ni-swd-bootstrap.hex`: first-time SWD image containing S113, QANI application, Nordic Secure DFU bootloader, and settings page.
- `revc-apple-ni-dfu-v1.zip`: signed application-only BLE update package (hardware version 3, SoftDevice requirement 0x102).
- `revc-apple-ni-application.hex`, `revc-secure-dfu-bootloader.hex`, and `revc-bootloader-settings.hex`: component images for inspection and recovery workflows.

The bootstrap's HEX records program S113 at 0x00000–0x1BFFF, QANI at 0x1C000–0x4D5FF, bootloader at 0x65000–0x6AFFF, UICR bootloader start, and settings at 0x7F000. FDS uses 0x63000–0x64FFF. The bootstrap contains no records for FDS, UWB calibration at 0x7B000–0x7CFFF, MBR parameters at 0x7E000, or backup settings. Use range erase so those areas remain untouched.

## State and limits

These development artifacts were compiled and statically checked for their address ranges. They have **not** been programmed or smoke-tested on Rev.C hardware. The QANI build uses Qorvo's DWM3001CDK module-board target. Verify Rev.C UWB pin behavior and the BLE app-to-bootloader transition over J5 before treating this as a supported release.

The DFU package is signed by a local development private key. Keep that key backed up securely; without it, compatible application updates cannot be signed and the module must be re-provisioned over SWD. Never publish the private key.

## License notices

The QANI application and Nordic firmware components carry license obligations. See `../LicenseRef-QORVO-2.txt`, `../nRF5_Nordic_license.txt`, and `../s113_nrf52_7.2.0_licence-agreement.txt`.
