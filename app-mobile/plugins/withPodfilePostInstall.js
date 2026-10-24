// useFrameworks:'static' (expo-build-properties) + @react-native-firebase deu
// uma cadeia de erros de Clang Modules sem solucao estavel (RCTPromiseRejectBlock
// "dono" disputado entre RNFBApp/RNFBMessaging, RCT_EXTERN sumindo em outros
// arquivos) — nenhuma combinacao de build settings/patch resolveu de vez.
// Projeto passou pra useFrameworks:'dynamic', que nao exige esse regime
// rigido de modulos. CLANG_ALLOW_NON_MODULAR_INCLUDES fica so como rede de
// seguranca, nao faz mal em dynamic. Projeto e "managed" (sem pasta ios/
// versionada, gerada de novo a cada build), entao isso precisa ser um config
// plugin em vez de editar o Podfile direto.
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SNIPPET = `
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |config|
        config.build_settings['CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES'] = 'YES'
      end
    end
`;

module.exports = function withPodfilePostInstall(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfilePath, 'utf-8');

      if (!contents.includes('CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES')) {
        contents = contents.replace(
          /post_install do \|installer\|/,
          `post_install do |installer|\n${SNIPPET}`
        );
      }

      fs.writeFileSync(podfilePath, contents);
      return config;
    },
  ]);
};
