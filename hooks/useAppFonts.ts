import { useFonts } from 'expo-font';
import {
  SpaceGrotesk_400Regular,
  SpaceGrotesk_500Medium,
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
} from '@expo-google-fonts/space-grotesk';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_700Bold,
} from '@expo-google-fonts/jetbrains-mono';

/**
 * 앱에서 사용하는 커스텀 폰트를 로드한다.
 *
 * `constants/theme.ts`의 `fonts` 토큰과 이름이 일치해야 한다.
 * 로딩 실패 시에도 화면이 계속 빈 상태로 남지 않도록 에러를 로그하고 렌더링을 진행시킨다.
 * @returns 폰트 로딩 시도가 끝났는지 여부(성공 또는 실패)
 */
export function useAppFonts(): boolean {
  const [fontsLoaded, fontError] = useFonts({
    SpaceGrotesk_400Regular,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
    JetBrainsMono_700Bold,
  });

  if (fontError) {
    console.error('폰트 로딩 실패:', fontError);
  }

  return fontsLoaded || !!fontError;
}
