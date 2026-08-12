import { StyleSheet, Text, View } from 'react-native';

import { colors } from '../constants/theme';

type PlaceholderScreenProps = {
  label: string;
};

export function PlaceholderScreen({ label }: PlaceholderScreenProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.void,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    color: colors.ink,
  },
});
