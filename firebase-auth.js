(() => {
    const config = window.AVTODPROC_FIREBASE_CONFIG || {};
    const configured = config.apiKey && config.projectId && config.appId &&
        !config.apiKey.startsWith('YOUR_') &&
        !config.projectId.startsWith('YOUR_') &&
        !config.appId.startsWith('YOUR_');
    let auth = null;
    let database = null;
    let currentUser = null;
    let authFlowInProgress = false;
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

    function getAuthErrorMessage(error) {
        switch (error.code) {
            case 'auth/too-many-requests':
                return 'Շատ փորձեր են կատարվել կարճ ժամանակում։ Firebase-ը ժամանակավորապես սահմանափակել է գրանցումը․ սպասեք և փորձեք ավելի ուշ։';
            case 'auth/email-already-in-use':
                return 'Այս էլ․ փոստով հաշիվ արդեն կա։ Փորձեք մուտք գործել կամ օգտագործեք գաղտնաբառի վերականգնումը։';
            case 'auth/invalid-email':
                return 'Էլ․ փոստի հասցեն վավեր չէ։ Ստուգեք մուտքագրումը։';
            case 'auth/weak-password':
                return 'Գաղտնաբառը թույլ է։ Օգտագործեք առնվազն 8 նիշ՝ մեծատառով, փոքրատառով և թվով։';
            case 'auth/operation-not-allowed':
                return 'Email/Password մուտքը միացված չէ Firebase նախագծում։';
            default:
                return error.message || String(error);
        }
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
        showAuthMessage('Մուտքը միացնելու համար ստուգեք firebase-config.js-ը և Firebase Authentication-ի ու Firestore-ի կարգավորումները։', true);
    }

    function progressCollection(userId) {
        return database.collection('users').doc(userId).collection('test_progress');
    }

    function getCloudHistory(testId) {
        const history = window.getTestHistory(testId);
        return {
            test_id: testId,
            passed_attempts: history.passed,
            failed_attempts: history.failed,
            wrong_answers: history.wrongAnswers,
            last_result: history.lastResult
        };
    }

    async function saveActiveAttempt(attempt, userId) {
        if (!currentUser || currentUser.uid !== userId || !attempt || !attempt.currentTestId) return;
        const testId = Number(attempt.currentTestId);
        const row = {
            ...getCloudHistory(testId),
            active_attempt: attempt,
            updated_at: new Date().toISOString()
        };
        await enqueueCloudWrite(async () => {
            if (!currentUser || currentUser.uid !== userId) return;
            await progressCollection(userId).doc(String(testId)).set(row);
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
            active_attempt: null,
            updated_at: new Date().toISOString()
        };
        const userId = currentUser.uid;
        await enqueueCloudWrite(async () => {
            if (!currentUser || currentUser.uid !== userId) return;
            await progressCollection(userId).doc(String(testId)).set(row);
            setSyncStatus('Թեստի արդյունքը պահպանվեց ձեր հաշվում։');
        });
    }

    async function loadUserProgress(user) {
        setSyncStatus('Բեռնում ենք ձեր առաջընթացը…');
        window.clearTestHistoryInMemory();
        let snapshot;
        try {
            snapshot = await progressCollection(user.uid).get();
        } catch (error) {
            if (!currentUser || currentUser.uid !== user.uid) return;
            console.error('Could not load user test progress:', error);
            setSyncStatus(`Առաջընթացը չհաջողվեց բեռնել․ ${error.message || error}`, true);
            window.restoreTestProgress();
            return;
        }
        if (!currentUser || currentUser.uid !== user.uid) return;

        const data = snapshot.docs.map(document => document.data());
        window.setTestHistoryFromCloud(data);
        setSyncStatus('Մուտք եք գործել․ առաջընթացը պահվում է ձեր հաշվում։');
        const savedAttempt = data
            .filter(row => row.active_attempt && row.active_attempt.active)
            .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
        if (savedAttempt) {
            window.switchTab('tests');
            const cloudAttempt = { ...savedAttempt.active_attempt };
            if (!Number.isFinite(Number(cloudAttempt.updatedAt)) || Number(cloudAttempt.updatedAt) <= 0) {
                cloudAttempt.updatedAt = Date.parse(savedAttempt.updated_at) || 0;
            }
            window.restoreCloudTestAttempt(cloudAttempt);
        } else {
            window.restoreTestProgress();
        }
    }

    async function applyUser(nextUser) {
        if (nextUser && !nextUser.emailVerified) {
            currentUser = null;
            window.currentProgressUserId = null;
            setSignedInControls(null);
            window.loadLocalTestHistory();
            if (!authFlowInProgress) {
                showAuthMessage('Այս հաշիվը դեռ հաստատված չէ։ Բացեք էլ․ փոստին ուղարկված հղումը, ապա նորից մուտք գործեք։', true);
                await auth.signOut();
            }
            return;
        }

        const oldUserId = currentUser ? currentUser.uid : null;
        const nextUserId = nextUser ? nextUser.uid : null;
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
        if (!configured) showConfigurationHelp();
    };

    window.closeAuthModal = function () {
        document.getElementById('auth-modal')?.classList.add('hidden');
    };

    window.signInUser = async function () {
        if (!auth) return showConfigurationHelp();
        const emailInput = document.getElementById('auth-email');
        const email = emailInput.value.trim().toLowerCase();
        const password = document.getElementById('auth-password').value;
        if (!emailInput.checkValidity()) {
            showAuthMessage('Մուտքագրեք վավեր էլ․ փոստի հասցե։', true);
            return;
        }
        authFlowInProgress = true;
        try {
            const credential = await auth.signInWithEmailAndPassword(email, password);
            await credential.user.reload();
            if (!credential.user.emailVerified) {
                try {
                    await credential.user.sendEmailVerification();
                    showAuthMessage('Այս էլ․ փոստը դեռ հաստատված չէ։ Նոր հաստատման հղում ուղարկեցինք․ ստուգեք նաև Spam պանակը։', true);
                } finally {
                    await auth.signOut();
                }
                return;
            }
            showAuthMessage('Մուտքը հաջողվեց։');
            window.closeAuthModal();
        } catch (error) {
            console.error('Could not sign in:', error);
            showAuthMessage(`Մուտքը չհաջողվեց․ ${getAuthErrorMessage(error)}`, true);
        } finally {
            authFlowInProgress = false;
        }
    };

    window.registerUser = async function () {
        if (!auth) return showConfigurationHelp();
        const emailInput = document.getElementById('auth-email');
        const email = emailInput.value.trim().toLowerCase();
        const password = document.getElementById('auth-password').value;
        if (!emailInput.checkValidity()) {
            showAuthMessage('Մուտքագրեք վավեր էլ․ փոստի հասցե։', true);
            return;
        }
        if (password.length < 8 || !/[a-z]/.test(password) ||
            !/[A-Z]/.test(password) || !/\d/.test(password)) {
            showAuthMessage('Գաղտնաբառը պետք է ունենա առնվազն 8 նիշ, մեկ փոքրատառ, մեկ մեծատառ և մեկ թիվ։', true);
            return;
        }
        authFlowInProgress = true;
        try {
            const credential = await auth.createUserWithEmailAndPassword(email, password);
            try {
                await credential.user.sendEmailVerification();
                showAuthMessage('Հաստատման հղում ուղարկեցինք ձեր էլ․ փոստին։ Բացեք նամակը և հաստատեք հասցեն, հետո վերադարձեք ու մուտք գործեք։ Ստուգեք նաև Spam պանակը։');
            } finally {
                await auth.signOut();
            }
        } catch (error) {
            console.error('Could not register account:', error);
            showAuthMessage(`Գրանցումը չհաջողվեց․ ${getAuthErrorMessage(error)}`, true);
        } finally {
            authFlowInProgress = false;
        }
    };

    window.signOutUser = async function () {
        if (!auth || !currentUser) return;
        if (!document.getElementById('active-test-view').classList.contains('hidden')) {
            await window.backToTestsList();
        }
        await flushPendingAttempt();
        try {
            await auth.signOut();
        } catch (error) {
            console.error('Could not sign out:', error);
            setSyncStatus(`Դուրս գալը չհաջողվեց․ ${error.message || error}`, true);
        }
    };

    window.saveActiveAttemptToCloud = function (attempt) {
        if (!currentUser || !attempt || !attempt.currentTestId) return;
        pendingAttempt = { attempt, userId: currentUser.uid };
        if (attemptSaveTimer) return;
        attemptSaveTimer = setTimeout(() => {
            attemptSaveTimer = null;
            flushPendingAttempt();
        }, 1500);
    };

    window.saveTestResultToCloud = saveTestResult;

    window.resetTestProgressInCloud = async function () {
        if (!currentUser) return;
        if (attemptSaveTimer) {
            clearTimeout(attemptSaveTimer);
            attemptSaveTimer = null;
        }
        pendingAttempt = null;

        const userId = currentUser.uid;
        const operation = cloudWriteQueue.then(async () => {
            if (!currentUser || currentUser.uid !== userId) {
                throw new Error('Հաշիվը փոխվել է։ Նորից փորձեք զրոյացնել առաջընթացը։');
            }
            const snapshot = await progressCollection(userId).get();
            if (snapshot.empty) return;
            const batch = database.batch();
            snapshot.docs.forEach(document => batch.delete(document.ref));
            await batch.commit();
        });
        cloudWriteQueue = operation.catch(error => {
            console.error('Could not reset cloud test progress:', error);
            setSyncStatus(`Ամպային առաջընթացը չհաջողվեց զրոյացնել․ ${error.message || error}`, true);
        });
        await operation;
    };

    window.addEventListener('DOMContentLoaded', () => {
        setSignedInControls(null);
        if (!configured) {
            const note = document.getElementById('tests-progress-account-note');
            if (note) note.textContent = 'Առաջընթացը պահվում է այս սարքում։ Ամպային հաշիվը միացնելու համար կարգավորեք Firebase-ը։';
            return;
        }
        if (!window.firebase || typeof window.firebase.initializeApp !== 'function' ||
            typeof window.firebase.firestore !== 'function') {
            setSyncStatus('Firebase SDK-ը չբեռնվեց․ ստուգեք ինտերնետային կապը։', true);
            return;
        }

        try {
            const app = window.firebase.initializeApp(config);
            auth = app.auth();
            database = app.firestore();
            window.testProgressAuthManaged = true;
            window.currentProgressUserId = null;
            auth.onAuthStateChanged(user => {
                applyUser(user).catch(error => {
                    console.error('Could not apply Firebase account:', error);
                    setSyncStatus(`Հաշվի առաջընթացը չհաջողվեց բեռնել․ ${error.message || error}`, true);
                });
            }, error => {
                console.error('Could not check Firebase account:', error);
                setSyncStatus(`Հաշիվը չհաջողվեց ստուգել․ ${error.message || error}`, true);
            });
        } catch (error) {
            console.error('Could not initialize Firebase:', error);
            setSyncStatus(`Firebase-ը չհաջողվեց միացնել․ ${error.message || error}`, true);
        }
    });
})();
