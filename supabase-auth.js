(() => {
    const config = window.AVTODPROC_SUPABASE_CONFIG || {};
    const configured = config.url && config.anonKey &&
        !config.url.startsWith('YOUR_') && !config.anonKey.startsWith('YOUR_');
    let client = null;
    let currentUser = null;
    let pendingAttempt = null;
    let attemptSaveTimer = null;
    let cloudWriteQueue = Promise.resolve();

    function enqueueCloudWrite(write) {
        const result = cloudWriteQueue.then(write);
        cloudWriteQueue = result.catch(error => {
            console.error('Cloud progress synchronization failed:', error);
            setSyncStatus(`Ամպային համաժամացումը ձախողվեց․ ${error.message || error}`, true);
        });
        return result.catch(() => undefined);
    }

    function setSyncStatus(message, isError = false) {
        const status = document.getElementById('auth-sync-status');
        if (status) {
            status.textContent = message;
            status.className = `text-xs ${isError ? 'text-red-400' : 'text-gray-500'}`;
        }
        const note = document.getElementById('tests-progress-account-note');
        if (note && currentUser) {
            note.textContent = isError
                ? 'Առաջընթացը պահպանվում է այս սարքում, բայց ամպային համաժամացումը ձախողվեց։'
                : 'Մուտք եք գործել․ առաջընթացը պահվում է ձեր հաշվում և համաժամացվում է սարքերի միջև։';
            note.className = `text-xs ${isError ? 'text-red-400' : 'text-gray-500'}`;
        }
    }

    function showAuthMessage(message, isError = false) {
        const element = document.getElementById('auth-message');
        if (!element) return;
        element.textContent = message;
        element.className = `text-sm ${isError ? 'text-red-400' : 'text-neon-400'}`;
    }

    function setSignedInControls(user) {
        const email = document.getElementById('auth-user-email');
        const openButton = document.getElementById('auth-open-button');
        const signoutButton = document.getElementById('auth-signout-button');
        const mobileOpenButton = document.getElementById('mobile-auth-open-button');
        const mobileSignoutButton = document.getElementById('mobile-auth-signout-button');
        const signedIn = !!user;
        if (email) {
            email.textContent = signedIn ? user.email || 'Հաշիվ' : '';
            email.classList.toggle('hidden', !signedIn);
        }
        if (openButton) openButton.classList.toggle('hidden', signedIn);
        if (signoutButton) signoutButton.classList.toggle('hidden', !signedIn);
        if (mobileOpenButton) mobileOpenButton.classList.toggle('hidden', signedIn);
        if (mobileSignoutButton) mobileSignoutButton.classList.toggle('hidden', !signedIn);
    }

    function showConfigurationHelp() {
        const modal = document.getElementById('auth-modal');
        if (modal) modal.classList.remove('hidden');
        showAuthMessage('Մուտքը միացնելու համար լրացրեք supabase-config.js-ը և գործարկեք supabase-schema.sql-ը Supabase SQL Editor-ում։', true);
    }

    function getCloudHistory(testId) {
        const history = window.getTestHistory(testId);
        return {
            user_id: currentUser.id,
            test_id: testId,
            passed_attempts: history.passed,
            failed_attempts: history.failed,
            wrong_answers: history.wrongAnswers,
            last_result: history.lastResult
        };
    }

    async function saveActiveAttempt(attempt, userId) {
        if (!currentUser || currentUser.id !== userId || !attempt || !attempt.currentTestId) return;
        const row = {
            ...getCloudHistory(Number(attempt.currentTestId)),
            active_attempt: attempt,
            updated_at: new Date().toISOString()
        };
        await enqueueCloudWrite(async () => {
            if (!currentUser || currentUser.id !== userId) return;
            const { error } = await client.from('test_progress').upsert(row, { onConflict: 'user_id,test_id' });
            if (error) {
                console.error('Could not sync active test progress:', error);
                setSyncStatus(`Ամպային պահպանումը ձախողվեց․ ${error.message}`, true);
                return;
            }
            setSyncStatus('Ամպային պահպանումը միացված է։');
        });
    }

    async function flushPendingAttempt() {
        if (attemptSaveTimer) {
            clearTimeout(attemptSaveTimer);
            attemptSaveTimer = null;
        }
        const queued = pendingAttempt;
        pendingAttempt = null;
        if (queued) await saveActiveAttempt(queued.attempt, queued.userId);
    }

    async function saveTestResult(testId) {
        if (!currentUser) return;
        if (attemptSaveTimer && pendingAttempt &&
            Number(pendingAttempt.attempt.currentTestId) === Number(testId)) {
            clearTimeout(attemptSaveTimer);
            attemptSaveTimer = null;
            pendingAttempt = null;
        }
        const row = {
            ...getCloudHistory(Number(testId)),
            last_result: window.getTestHistory(testId).lastResult,
            active_attempt: null,
            updated_at: new Date().toISOString()
        };
        await enqueueCloudWrite(async () => {
            if (!currentUser) return;
            const { error } = await client.from('test_progress').upsert(row, { onConflict: 'user_id,test_id' });
            if (error) {
                console.error('Could not sync test result:', error);
                setSyncStatus(`Արդյունքը չհաջողվեց պահպանել բազայում․ ${error.message}`, true);
                return;
            }
            setSyncStatus('Թեստի արդյունքը պահպանվեց ձեր հաշվում։');
        });
    }

    async function loadUserProgress(user) {
        setSyncStatus('Բեռնում ենք ձեր առաջընթացը…');
        window.clearTestHistoryInMemory();
        let data;
        let error;
        try {
            ({ data, error } = await client
                .from('test_progress')
                .select('test_id, passed_attempts, failed_attempts, wrong_answers, last_result, active_attempt, updated_at')
                .eq('user_id', user.id));
        } catch (requestError) {
            if (!currentUser || currentUser.id !== user.id) return;
            console.error('Could not load user test progress:', requestError);
            setSyncStatus(`Առաջընթացը չհաջողվեց բեռնել․ ${requestError.message || requestError}`, true);
            return;
        }
        if (!currentUser || currentUser.id !== user.id) return;
        if (error) {
            console.error('Could not load user test progress:', error);
            setSyncStatus(`Առաջընթացը չհաջողվեց բեռնել․ ${error.message}`, true);
            return;
        }

        window.setTestHistoryFromCloud(data || []);
        setSyncStatus('Մուտք եք գործել․ առաջընթացը պահվում է ձեր հաշվում։');
        const savedAttempt = (data || [])
            .filter(row => row.active_attempt && row.active_attempt.active)
            .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
        if (savedAttempt) {
            window.switchTab('tests');
            window.restoreCloudTestAttempt(savedAttempt.active_attempt);
        } else {
            window.restoreTestProgress();
        }
    }

    async function applySession(session) {
        const nextUser = session && session.user ? session.user : null;
        const oldUserId = currentUser ? currentUser.id : null;
        const nextUserId = nextUser ? nextUser.id : null;
        if (oldUserId === nextUserId) return;

        currentUser = nextUser;
        window.currentProgressUserId = nextUserId;
        setSignedInControls(nextUser);
        if (nextUser) {
            await loadUserProgress(nextUser);
            return;
        }

        window.loadLocalTestHistory();
        const note = document.getElementById('tests-progress-account-note');
        if (note) {
            note.textContent = 'Առաջընթացը պահվում է այս սարքում։ Մուտք գործեք՝ ձեր հաշվում այն պահպանելու համար։';
            note.className = 'text-xs text-gray-500';
        }
        setSyncStatus('Դուրս եք եկել ձեր հաշվից։');
        window.restoreTestProgress();
    }

    window.openAuthModal = function () {
        const modal = document.getElementById('auth-modal');
        if (modal) modal.classList.remove('hidden');
        const message = document.getElementById('auth-message');
        if (message) {
            message.textContent = '';
            message.className = 'hidden text-sm';
        }
        if (!configured) {
            showAuthMessage('Նախ կարգավորեք Supabase-ը․ քայլերը նշված են supabase-config.js և supabase-schema.sql ֆայլերում։', true);
        }
    };

    window.closeAuthModal = function () {
        document.getElementById('auth-modal')?.classList.add('hidden');
    };

    window.signInUser = async function () {
        if (!client) return showConfigurationHelp();
        const email = document.getElementById('auth-email').value.trim();
        const password = document.getElementById('auth-password').value;
        try {
            const { error } = await client.auth.signInWithPassword({ email, password });
            if (error) {
                showAuthMessage(error.message, true);
                return;
            }
            showAuthMessage('Մուտքը հաջողվեց։');
            window.closeAuthModal();
        } catch (error) {
            console.error('Could not sign in:', error);
            showAuthMessage(`Մուտքը չհաջողվեց․ ${error.message || error}`, true);
        }
    };

    window.registerUser = async function () {
        if (!client) return showConfigurationHelp();
        const email = document.getElementById('auth-email').value.trim();
        const password = document.getElementById('auth-password').value;
        if (!email || password.length < 6) {
            showAuthMessage('Մուտքագրեք վավեր էլ․ փոստ և առնվազն 6 նիշանոց գաղտնաբառ։', true);
            return;
        }
        try {
            const { data, error } = await client.auth.signUp({ email, password });
            if (error) {
                showAuthMessage(error.message, true);
                return;
            }
            showAuthMessage(data.session
                ? 'Գրանցումն ավարտված է, մուտք եք գործել։'
                : 'Գրանցումը հաջողվեց․ հաստատեք ձեր էլ․ փոստը, ապա մուտք գործեք։');
        } catch (error) {
            console.error('Could not register account:', error);
            showAuthMessage(`Գրանցումը չհաջողվեց․ ${error.message || error}`, true);
        }
    };

    window.signOutUser = async function () {
        if (!client || !currentUser) return;
        if (!document.getElementById('active-test-view').classList.contains('hidden')) {
            window.backToTestsList();
        }
        await flushPendingAttempt();
        try {
            const { error } = await client.auth.signOut();
            if (error) {
                console.error('Could not sign out:', error);
                setSyncStatus(`Դուրս գալը չհաջողվեց․ ${error.message}`, true);
            }
        } catch (error) {
            console.error('Could not sign out:', error);
            setSyncStatus(`Դուրս գալը չհաջողվեց․ ${error.message || error}`, true);
        }
    };

    window.saveActiveAttemptToCloud = function (attempt) {
        if (!currentUser || !attempt || !attempt.currentTestId) return;
        pendingAttempt = { attempt, userId: currentUser.id };
        if (attemptSaveTimer) return;
        attemptSaveTimer = setTimeout(() => {
            attemptSaveTimer = null;
            flushPendingAttempt();
        }, 1500);
    };

    window.saveTestResultToCloud = saveTestResult;

    window.addEventListener('DOMContentLoaded', async () => {
        setSignedInControls(null);
        if (!configured) {
            const note = document.getElementById('tests-progress-account-note');
            if (note) note.textContent = 'Առաջընթացը պահվում է այս սարքում։ Ամպային հաշիվը միացնելու համար կարգավորեք Supabase-ը։';
            return;
        }
        if (!window.supabase || typeof window.supabase.createClient !== 'function') {
            setSyncStatus('Supabase SDK-ը չբեռնվեց․ ստուգեք ինտերնետային կապը։', true);
            return;
        }

        window.testProgressAuthManaged = true;
        window.currentProgressUserId = null;
        client = window.supabase.createClient(config.url, config.anonKey);
        const { data, error } = await client.auth.getSession();
        if (error) {
            console.error('Could not read Supabase session:', error);
            setSyncStatus(`Հաշիվը չհաջողվեց ստուգել․ ${error.message}`, true);
        } else {
            await applySession(data.session);
            if (!data.session) window.restoreTestProgress();
        }
        client.auth.onAuthStateChange((_event, session) => {
            setTimeout(() => {
                applySession(session).catch(error => {
                    console.error('Could not apply Supabase session:', error);
                    setSyncStatus(`Հաշվի առաջընթացը չհաջողվեց բեռնել․ ${error.message || error}`, true);
                });
            }, 0);
        });
    });
})();
