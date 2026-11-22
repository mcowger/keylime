Pod::Spec.new do |s|
  s.name             = 'KeylimeNetwork'
  s.version          = '1.0.0'
  s.summary          = 'Origin-isolated networking for Keylime'
  s.description      = 'Private HTTP and WebSocket transport for the Keylime iOS app.'
  s.license          = { :type => 'MIT' }
  s.author           = 'Keylime'
  s.homepage         = 'https://github.com/Keylime-AI/keylime'
  s.platforms        = { :ios => '16.4' }
  s.swift_version    = '5.9'
  s.source           = { :git => 'https://github.com/Keylime-AI/keylime.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,swift}'
end
