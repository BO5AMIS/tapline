Pod::Spec.new do |s|
  s.name = 'TaplineNative'
  s.version = '1.0.0'
  s.summary = 'Tapline: frames without a forced render, and what iOS draws over the app'
  s.license = { :type => 'MIT' }
  s.author = 'Tapline'
  s.homepage = 'https://github.com/tapline/tapline'
  s.platforms = { :ios => '16.4' }
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.swift_version = '5.9'
  s.source_files = 'ios/**/*.swift'
end
