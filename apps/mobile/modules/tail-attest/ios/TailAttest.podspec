Pod::Spec.new do |s|
  s.name           = 'TailAttest'
  s.version        = '0.1.0'
  s.summary        = 'TAIL native module (tail-attest)'
  s.description    = 'Local Expo module of the TAIL iOS app.'
  s.license        = 'AGPL-3.0-only'
  s.author         = 'TAIL'
  # CocoaPods requires a homepage; this is the Expo modules doc, as in Expo's local-module template.
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
