Pod::Spec.new do |s|
  s.name = 'TaplineNative'
  s.version = '1.0.0'
  s.summary = 'Tapline: frames without a forced render, and what iOS draws over the app'
  s.license = { :type => 'MIT' }
  s.author = 'Tapline'
  s.homepage = 'https://github.com/tapline/tapline'
  # 15.1 is the floor of Expo SDK 55 and React Native 0.83. CocoaPods skips a pod that needs a newer iOS than the
  # app, silently, so a higher number here left SDK 55 apps without the module (found by the native CI job).
  s.platforms = { :ios => '15.1' }
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.swift_version = '5.9'
  s.source_files = 'ios/**/*.swift'
end
